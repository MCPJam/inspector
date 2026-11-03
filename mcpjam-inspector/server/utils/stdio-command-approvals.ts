/**
 * Per-device approval of the command a STDIO server runs.
 *
 * The approval is keyed by server id and bound to a fingerprint of the exact
 * launch spec, so an edit to the command, its args, its env (names or
 * values) or its working directory asks again. It lives on this machine
 * because the local server process IS the device: every spawn path (the
 * /api/mcp connect, the web-route stdio divert) resolves through
 * `applyLocalRuntimeResolution`, which enforces it.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { lock } from "proper-lockfile";
import { describeError } from "@mcpjam/sdk";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import {
  createCapabilityMutationLock,
  persistCapabilityState,
} from "./local-capability.js";
import {
  STDIO_COMMAND_APPROVAL_REQUIRED_REASON,
  type StdioCommandApprovalTerms,
} from "../../shared/stdio-command-approval.js";

export interface StdioLaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

/** The one way a stdio config becomes the spec that is fingerprinted and approved. */
export function toStdioLaunchSpec(config: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}): StdioLaunchSpec {
  return {
    command: config.command,
    args: config.args ?? [],
    env: config.env ?? {},
    ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
  };
}

export function stdioLaunchFingerprint(spec: StdioLaunchSpec): string {
  const env = Object.fromEntries(
    Object.entries(spec.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return createHash("sha256")
    .update(JSON.stringify([spec.command, spec.args, env, spec.cwd ?? null]))
    .digest("hex");
}

/** `changed` means this device approved an earlier version of the command. */
export type StdioLaunchApproval = "approved" | "changed" | "none";

export interface StdioLaunchCheck {
  approval: StdioLaunchApproval;
  fingerprint: string;
  /** Env names added, changed or removed since the last approval, when `changed`. */
  changedEnvNames?: string[];
}

interface PersistedApprovals {
  version: 1;
  approvals: Record<
    string,
    {
      fingerprint: string;
      approvedAt: string;
      /** Per-variable digests, so a refusal can name what changed. */
      envValueHashes?: Record<string, string>;
    }
  >;
}

function envValueHash(name: string, value: string): string {
  return createHash("sha256")
    .update(JSON.stringify([name, value]))
    .digest("hex");
}

export const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export function createStdioCommandApprovalStore(filePath: () => string) {
  const serialize = createCapabilityMutationLock();

  /**
   * `strict` is for `approve`, which rewrites the file from what this returns:
   * a read that failed for any reason but a missing file must not drop every
   * other server's approval, and a file that does not parse is moved aside so
   * what it held can still be recovered by hand.
   */
  async function readApprovals(
    strict = false,
  ): Promise<PersistedApprovals["approvals"]> {
    let text: string;
    try {
      text = await readFile(filePath(), "utf8");
    } catch (error) {
      if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
      return {};
    }
    let approvals: unknown;
    try {
      approvals = (JSON.parse(text) as Partial<PersistedApprovals> | null)
        ?.approvals;
    } catch {
      approvals = undefined;
    }
    if (!approvals || typeof approvals !== "object") {
      if (strict) await rename(filePath(), `${filePath()}.unreadable`);
      return {};
    }
    return Object.fromEntries(
      Object.entries(approvals as PersistedApprovals["approvals"]).filter(
        ([, entry]) =>
          typeof entry?.fingerprint === "string" &&
          FINGERPRINT_PATTERN.test(entry.fingerprint),
      ),
    );
  }

  async function read(
    serverId: string,
    spec: StdioLaunchSpec,
  ): Promise<StdioLaunchCheck> {
    const fingerprint = stdioLaunchFingerprint(spec);
    const stored = (await readApprovals())[serverId];
    if (!stored) return { approval: "none", fingerprint };
    if (stored.fingerprint === fingerprint)
      return { approval: "approved", fingerprint };
    const approved: Record<string, unknown> =
      stored.envValueHashes && typeof stored.envValueHashes === "object"
        ? stored.envValueHashes
        : {};
    const has = (name: string) =>
      Object.prototype.hasOwnProperty.call(spec.env, name);
    const changedEnvNames = [
      ...new Set([...Object.keys(spec.env), ...Object.keys(approved)]),
    ].filter(
      (name) =>
        approved[name] !==
        (has(name) ? envValueHash(name, spec.env[name]) : undefined),
    );
    return { approval: "changed", fingerprint, changedEnvNames };
  }

  function approve(serverId: string, spec: StdioLaunchSpec): Promise<void> {
    return serialize(async () => {
      const file = filePath();
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const release = await lock(file, {
        realpath: false,
        retries: { retries: 40, minTimeout: 25, maxTimeout: 100 },
        stale: 10_000,
      });
      try {
        const approvals = await readApprovals(true);
        approvals[serverId] = {
          fingerprint: stdioLaunchFingerprint(spec),
          approvedAt: new Date().toISOString(),
          envValueHashes: Object.fromEntries(
            Object.entries(spec.env).map(([name, value]) => [
              name,
              envValueHash(name, value),
            ]),
          ),
        };
        const state: PersistedApprovals = { version: 1, approvals };
        await persistCapabilityState(file, state);
      } finally {
        await release();
      }
    });
  }

  return { read, approve };
}

/** `MCPJAM_STDIO_APPROVALS_FILE` relocates the file; it never disables the check. */
export function stdioCommandApprovalsFilePath(): string {
  return (
    process.env.MCPJAM_STDIO_APPROVALS_FILE ||
    join(homedir(), ".mcpjam", "inspector", "stdio-approvals.json")
  );
}

const defaultStore = createStdioCommandApprovalStore(
  stdioCommandApprovalsFilePath,
);
export const checkStdioLaunchApproval = defaultStore.read;
export const approveStdioLaunch = defaultStore.approve;

/**
 * Variables that make the runtime load other code, so their value decides
 * what runs. They are never credentials, so the dialog shows their value;
 * every other value stays on this machine.
 */
const CODE_LOADING_ENV_NAME =
  /^(NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_\w+|PATH|PYTHONPATH)$/i;

export function stdioCommandApprovalTerms(args: {
  serverId: string;
  spec: StdioLaunchSpec;
  fingerprint: string;
  approval: Exclude<StdioLaunchApproval, "approved">;
  /** From {@link checkStdioLaunchApproval}, when the approval is `changed`. */
  changedEnvNames?: string[];
}): StdioCommandApprovalTerms {
  const codeLoading = Object.entries(args.spec.env).filter(([name]) =>
    CODE_LOADING_ENV_NAME.test(name),
  );
  return {
    serverId: args.serverId,
    fingerprint: args.fingerprint,
    command: args.spec.command,
    args: args.spec.args,
    envNames: Object.keys(args.spec.env),
    ...(args.changedEnvNames ? { changedEnvNames: args.changedEnvNames } : {}),
    ...(codeLoading.length > 0
      ? { codeLoadingEnv: Object.fromEntries(codeLoading) }
      : {}),
    ...(args.spec.cwd !== undefined ? { cwd: args.spec.cwd } : {}),
    previouslyApproved: args.approval === "changed",
  };
}

export function stdioCommandApprovalRequired(args: {
  serverId: string;
  serverDisplayName: string;
  spec: StdioLaunchSpec;
  fingerprint: string;
  approval: Exclude<StdioLaunchApproval, "approved">;
  changedEnvNames?: string[];
  /** A plugin's local component: it has no Connect, the chat asks instead. */
  pluginComponent?: boolean;
}): WebRouteError {
  const name = `"${args.serverDisplayName}"`;
  // Shown where no dialog can open (swarms, eval authoring, the environment
  // tools pane), pointing at the surface that asks.
  const where = args.pluginComponent
    ? "Use it in a chat"
    : "Connect it from Servers";
  const message =
    args.approval === "changed"
      ? `The command ${name} runs changed since this device approved it. ${where} to review and approve the new command.`
      : `${name} runs a command this device has not approved yet. ${where} to review and approve the command.`;
  const error = new WebRouteError(
    403,
    ErrorCode.STDIO_COMMAND_APPROVAL_REQUIRED,
    message,
    {
      reason: STDIO_COMMAND_APPROVAL_REQUIRED_REASON,
      serverId: args.serverId,
      serverName: args.serverDisplayName,
      approval: stdioCommandApprovalTerms(args),
    },
  );
  // Classified by its status alone this reads "Forbidden (403)" with OAuth
  // next steps, and the server card, where an auto-connect refusal lands,
  // renders exactly that block.
  error.normalized = {
    ...describeError(error, { surface: "mcpServer" }),
    title: "Command not approved on this device",
    oneLine: message,
    likelyCauses: [],
    nextSteps: [],
    docsAnchor: "/troubleshooting/error-codes",
  };
  return error;
}

/**
 * A pending command approval among a tolerant manager's refused servers. It is
 * a question for the person at the chat, not a server that failed, so a turn
 * must not quietly run without it.
 */
export function pendingStdioCommandApproval(
  refused: Record<string, unknown> | undefined,
): WebRouteError | undefined {
  return Object.values(refused ?? {}).find(
    (error): error is WebRouteError =>
      error instanceof WebRouteError &&
      error.code === ErrorCode.STDIO_COMMAND_APPROVAL_REQUIRED,
  );
}
