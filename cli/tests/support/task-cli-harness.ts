import { spawn } from "node:child_process";
import path from "node:path";

const CLI_DIR = process.cwd().endsWith(`${path.sep}cli`)
  ? process.cwd()
  : path.join(process.cwd(), "cli");

/**
 * The BUILT CLI, not `src/index.ts` under `tsx`.
 *
 * Every spawn here paid tsx's transpile on the way in: 0.85 s wall / 1.15 s
 * user per run against 0.35 s / 0.40 s for the bundle. Across the ~114 spawns
 * in this suite that was most of the cli lane's wall clock, and the lane was
 * the critical path of the whole PR gate.
 *
 * `pretest:fast` in cli/package.json builds this before the suite runs. The
 * outer `tsx` in scripts/run-tests.mjs — the one that executes the .ts test
 * files themselves — is untouched; only the CLI the tests spawn changes.
 */
const CLI_ENTRY_PATH = path.join(CLI_DIR, "dist", "index.js");

export interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawns the CLI the way a user would.
 *
 * The task verbs are judged end to end — exit code plus the parsed stdout
 * envelope — because that pair is the actual contract with a script, and an
 * in-process call would skip the commander wiring and the exit-code mapping
 * that most of these tests exist to pin.
 */
/**
 * Watchdog for a run that never terminates.
 *
 * Generous, because these tests spawn a real CLI against a real socket. Its job
 * is to convert "the suite hangs and leaves an orphan child" — the failure mode
 * a regressed signal path produces — into a named, attributable failure.
 */
const DEFAULT_RUN_TIMEOUT_MS = 120_000;

export function runCli(
  args: string[],
  input?: string,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY_PATH, ...args], {
      cwd: CLI_DIR,
      env: {
        ...process.env,
        MCPJAM_CLI_DISABLE_BROWSER_OPEN: "1",
        MCPJAM_TELEMETRY_DISABLED: "1",
        NODE_NO_WARNINGS: "1",
        // Every run must decide interactivity from its flags alone; a CI
        // variable leaking in from the host would silently disarm --interactive.
        CI: "",
        MCPJAM_NON_INTERACTIVE: "",
        // Clearing CI above also un-suppresses the update notifier, which would
        // otherwise reach npm once per spawn. Suppress it explicitly instead.
        MCPJAM_NO_UPDATE_CHECK: "1",
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);

    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `CLI did not exit within ${options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS}ms: ` +
              `mcpjam ${args.join(" ")}\n${stderr}`,
          ),
        );
        return;
      }
      if (code === null) {
        reject(new Error(`CLI killed by signal\n${stderr}`));
        return;
      }
      resolve({ exitCode: code, stdout, stderr });
    });

    child.stdin.end(input ?? "");
  });
}

/**
 * Last parseable JSON line of stdout.
 *
 * Watch runs interleave human status on stderr, but a stray line on stdout
 * would still break a naive `JSON.parse(stdout)`; scanning backwards keeps the
 * assertion on the envelope the command actually committed to.
 */
export function lastJsonLine(stdout: string): unknown {
  const lines = stdout.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]!);
    } catch {
      continue;
    }
  }
  throw new Error(`No JSON found in stdout:\n${stdout}`);
}

export function jsonOf(run: CliRun): Record<string, unknown> {
  return lastJsonLine(run.stdout) as Record<string, unknown>;
}

/** The structured error the CLI writes to stderr on a `CliError`. */
export function errorOf(run: CliRun): { code: string; message: string } {
  const parsed = lastJsonLine(run.stderr) as {
    error?: { code: string; message: string };
  };
  if (!parsed.error) throw new Error(`No structured error in stderr:\n${run.stderr}`);
  return parsed.error;
}

export function httpTarget(url: string): string[] {
  return ["--url", url, "--transport", "http"];
}
