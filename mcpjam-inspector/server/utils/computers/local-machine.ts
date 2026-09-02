/**
 * Local computer engine — bash on the machine that runs this inspector.
 *
 * The Playground's "This machine" engine: same tool shape and clamps as the
 * E2B pipeline (`run-command.ts`), none of its control plane. No Convex row
 * exists for the local machine, so there is no reserve/wake, no sandbox-info
 * exchange, and no `recordComputerCommand` — commands append to a local JSONL
 * instead.
 *
 * TRUST MODEL — read before editing:
 *  - This is NOT a sandbox. Commands run as the OS user with all of that
 *    user's permissions. The boundaries are consent (a server-verified
 *    capability, `local-consent.ts`), per-command chat approval, and the
 *    actor gates in `engine.ts` — never paths.
 *  - The workspace dir is a CONVENTION (a tidy default cwd), not confinement.
 *    What IS validated is the project key itself, because it becomes a path
 *    segment under the fixed root: reject anything that isn't one bounded
 *    segment.
 *  - The child env is a minimal ALLOWLIST, not a secret-name denylist —
 *    denylists leak every round. This reduces accidental `env` leakage into
 *    transcripts; it is NOT a security boundary (same-user commands can read
 *    files and credential stores regardless).
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir, rename, stat, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { HOSTED_MODE, LOCAL_COMPUTER_ENABLED } from "../../config.js";
import { logger } from "../logger.js";
import { detectAuthUrls } from "./auth-urls.js";
import {
  DEFAULT_COMMAND_TIMEOUT_S,
  MAX_COMMAND_TIMEOUT_S,
  MODEL_OUTPUT_CAP,
  truncate,
  type BashRunner,
  type RunComputerCommandResult,
} from "./run-command.js";

export const LOCAL_COMPUTER_UNAVAILABLE_ERROR =
  "The local computer engine isn't available on this server.";

/** Sentinel for the `sandboxId` slot the BashRunner shape requires. */
export const LOCAL_ENGINE_SANDBOX_ID = "local-machine";

// Collected per stream BEFORE model truncation; keeps a runaway command from
// buffering unbounded output in this process.
const STREAM_COLLECT_CAP = 1_000_000;

const SIGKILL_GRACE_MS = 2_000;

/**
 * Environment ALLOWLIST for local commands and PTYs. Names only — values pass
 * through from this process untouched. Everything else (API keys, service
 * tokens, cloud credentials, database URLs, app config) is omitted.
 * Exported so tests lock the list — additions are deliberate, reviewed acts.
 */
export const LOCAL_COMMAND_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  // Windows requires these for anything to run at all.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
];

export function buildLocalCommandEnv(
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of LOCAL_COMMAND_ENV_ALLOWLIST) {
    const value = base[name];
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

let cachedBashPath: string | null | undefined;

/** Absolute path to a usable `bash`, or null (honest Windows/odd-PATH degrade). */
export function resolveLocalBashPath(
  base: NodeJS.ProcessEnv = process.env
): string | null {
  if (cachedBashPath !== undefined) return cachedBashPath;
  const names = process.platform === "win32" ? ["bash.exe"] : ["bash"];
  for (const dir of (base.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        cachedBashPath = candidate;
        return candidate;
      }
    }
  }
  cachedBashPath = null;
  return null;
}

/** Test seam: the bash-path probe is cached for the process lifetime. */
export function resetLocalBashPathCacheForTests(): void {
  cachedBashPath = undefined;
}

export function isLocalComputerEngineAvailable():
  | { available: true }
  | { available: false; reason: string } {
  if (HOSTED_MODE) {
    return { available: false, reason: "hosted servers never execute locally" };
  }
  if (!LOCAL_COMPUTER_ENABLED) {
    return {
      available: false,
      reason: "the local computer engine is disabled on this server",
    };
  }
  if (!resolveLocalBashPath()) {
    return {
      available: false,
      reason: "no bash was found on this machine's PATH",
    };
  }
  return { available: true };
}

const PROJECT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The request body's projectId is untrusted even though normal clients send
 * Convex ids — it becomes a path segment under the workspace root, so it must
 * be exactly one bounded segment: no separators, no traversal, no controls.
 */
export function validateLocalProjectKey(projectId: string): string {
  if (!PROJECT_KEY_PATTERN.test(projectId)) {
    throw new Error("Invalid project key for the local computer workspace.");
  }
  return projectId;
}

export function getLocalComputerWorkspaceRoot(): string {
  return join(homedir(), ".mcpjam", "computer");
}

/** Resolve (and lazily create, 0700) the per-project workspace directory. */
export async function getLocalComputerWorkspaceDir(
  projectId: string
): Promise<string> {
  const root = getLocalComputerWorkspaceRoot();
  const dir = resolve(root, validateLocalProjectKey(projectId));
  // Belt and braces on top of the segment validation: the RESOLVED path must
  // stay beneath the root.
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error("Local computer workspace escaped its root.");
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // `recursive: true` applies the mode only to dirs it creates — re-assert on
  // the ones that matter so a pre-existing loose tree tightens up.
  await chmod(root, 0o700).catch(() => {});
  await chmod(dir, 0o700).catch(() => {});
  return dir;
}

/**
 * Best-effort local command journal (`~/.mcpjam/computer/logs/commands.jsonl`).
 * Never fails the command; rotates at ~10MB by renaming to `.1` (one
 * generation — this is an audit convenience, not a log pipeline). Lines may
 * contain sensitive command text; the directory is 0700 for that reason.
 *
 * Exported so the local terminal WS route can journal its own open/close
 * (`source:"terminal"`, `action:"open"|"close"`) through the SAME writer —
 * a second journal file would split the audit trail. PTY keystrokes are
 * deliberately never journaled: unlike a discrete approved `bash` command,
 * an interactive session's bytes include passwords typed at prompts.
 */
const LOG_ROTATE_BYTES = 10 * 1024 * 1024;

export async function appendLocalCommandLog(entry: {
  ts: string;
  projectId: string;
  commandId: string;
  source: "chat" | "terminal";
  command?: string;
  exitCode?: number;
  outputPreview?: string;
  action?: "open" | "close";
}): Promise<void> {
  try {
    const dir = join(getLocalComputerWorkspaceRoot(), "logs");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, "commands.jsonl");
    const size = await stat(file).then(
      (s) => s.size,
      () => 0
    );
    if (size > LOG_ROTATE_BYTES) {
      await rename(file, `${file}.1`).catch(() => {});
    }
    await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  } catch (error) {
    logger.debug("[local-machine] command log append failed", { error });
  }
}

/**
 * BashRunner-shaped local executor. Ignores `sandboxId` (there is no sandbox);
 * spawns `bash -c` in its own process group so timeout/abort can kill the
 * whole tree, with a SIGKILL escalation after a short grace.
 */
export const localBashRunner: BashRunner = async ({
  command,
  workdir,
  timeoutMs,
  signal,
}) => {
  const bashPath = resolveLocalBashPath();
  if (!bashPath) {
    throw new Error("No bash available on this machine.");
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bashPath, ["-c", command], {
      ...(workdir ? { cwd: workdir } : {}),
      env: buildLocalCommandEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const killTree = () => {
      try {
        if (process.platform !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {}
      graceTimer = setTimeout(() => {
        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {}
      }, SIGKILL_GRACE_MS);
      graceTimer.unref?.();
    };

    const onAbort = () => killTree();
    signal?.addEventListener("abort", onAbort, { once: true });

    killTimer = setTimeout(killTree, timeoutMs);
    killTimer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      // Keep DRAINING past the cap (dropping data) so the child never blocks
      // on a full pipe; the model-facing truncation happens later anyway.
      if (stdout.length < STREAM_COLLECT_CAP) {
        stdout += chunk.toString("utf8");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STREAM_COLLECT_CAP) {
        stderr += chunk.toString("utf8");
      }
    });

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };

    child.on("error", (error) => settle(() => rejectPromise(error)));
    child.on("close", (code, sig) =>
      settle(() =>
        resolvePromise({
          stdout,
          stderr,
          // A signal exit (timeout/abort kill) reports 124, the conventional
          // timeout exit code, so the model sees a non-zero shell outcome.
          exitCode: code ?? (sig ? 124 : 1),
        })
      )
    );
  });
};

export interface RunLocalComputerCommandArgs {
  projectId: string;
  command: string;
  /** Idempotency/correlation key for the journal (tool call id). */
  commandId: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
}

/**
 * Local analogue of `runComputerCommand`: same clamps, same result shape,
 * no control plane. The host config's `computer.workdir` is deliberately NOT
 * accepted here — it carries `/home/user` (E2B) semantics; the local engine
 * always starts in the project workspace dir.
 */
export async function runLocalComputerCommand(
  args: RunLocalComputerCommandArgs,
  runner: BashRunner = localBashRunner
): Promise<RunComputerCommandResult> {
  const availability = isLocalComputerEngineAvailable();
  if (!availability.available) {
    return { error: LOCAL_COMPUTER_UNAVAILABLE_ERROR };
  }
  let workdir: string;
  try {
    workdir = await getLocalComputerWorkspaceDir(args.projectId);
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Could not prepare the local computer workspace.",
    };
  }
  const timeoutSeconds = Math.min(
    Math.max(args.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_S, 1),
    MAX_COMMAND_TIMEOUT_S
  );
  let result: { stdout: string; stderr: string; exitCode: number };
  try {
    result = await runner({
      sandboxId: LOCAL_ENGINE_SANDBOX_ID,
      command: args.command,
      workdir,
      timeoutMs: timeoutSeconds * 1000,
      ...(args.signal ? { signal: args.signal } : {}),
    });
  } catch (error) {
    logger.warn("[local-machine] exec failed", {
      projectId: args.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { error: "Command failed to run on this machine." };
  }

  void appendLocalCommandLog({
    ts: new Date().toISOString(),
    projectId: args.projectId,
    commandId: args.commandId,
    source: "chat",
    command: args.command,
    exitCode: result.exitCode,
    outputPreview: truncate(
      `${result.stdout}\n${result.stderr}`.trim(),
      2_000
    ),
  });

  const authUrls = detectAuthUrls(`${result.stdout}\n${result.stderr}`);
  return {
    stdout: truncate(result.stdout, MODEL_OUTPUT_CAP),
    stderr: truncate(result.stderr, MODEL_OUTPUT_CAP),
    exitCode: result.exitCode,
    ...(authUrls.length > 0 ? { authUrls } : {}),
  };
}
