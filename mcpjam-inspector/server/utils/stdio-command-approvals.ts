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
import { mkdir, readFile } from "node:fs/promises";
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

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export function createStdioCommandApprovalStore(filePath: () => string) {
  const serialize = createCapabilityMutationLock();

  /**
   * `strict` is for `approve`, which rewrites the file from what this returns:
   * a read that failed for any reason but a missing file must not drop every
   * other server's approval.
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
    try {
      const parsed: unknown = JSON.parse(text);
      const approvals = (parsed as Partial<PersistedApprovals> | null)
        ?.approvals;
      if (!approvals || typeof approvals !== "object") return {};
      return Object.fromEntries(
        Object.entries(approvals).filter(
          ([, entry]) =>
            typeof entry?.fingerprint === "string" &&
            FINGERPRINT_PATTERN.test(entry.fingerprint),
        ),
      );
    } catch {
      return {};
    }
  }

  async function read(
    serverId: string,
    fingerprint: string,
  ): Promise<StdioLaunchApproval> {
    const stored = (await readApprovals())[serverId]?.fingerprint;
    if (stored === undefined) return "none";
    return stored === fingerprint ? "approved" : "changed";
  }

  /** Env names added, changed or removed since the last approval. */
  async function changedEnvNames(
    serverId: string,
    env: Record<string, string>,
  ): Promise<string[]> {
    const stored = (await readApprovals())[serverId]?.envValueHashes;
    const approved: Record<string, unknown> =
      stored && typeof stored === "object" ? stored : {};
    const has = (name: string) =>
      Object.prototype.hasOwnProperty.call(env, name);
    return [...new Set([...Object.keys(env), ...Object.keys(approved)])].filter(
      (name) =>
        approved[name] !==
        (has(name) ? envValueHash(name, env[name]) : undefined),
    );
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

  return { read, changedEnvNames, approve };
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
export const readStdioLaunchApproval = defaultStore.read;
export const readChangedEnvNames = defaultStore.changedEnvNames;
export const approveStdioLaunch = defaultStore.approve;

export function stdioCommandApprovalTerms(args: {
  serverId: string;
  spec: StdioLaunchSpec;
  fingerprint: string;
  approval: Exclude<StdioLaunchApproval, "approved">;
  /** From {@link readChangedEnvNames}, when the approval is `changed`. */
  changedEnvNames?: string[];
}): StdioCommandApprovalTerms {
  return {
    serverId: args.serverId,
    fingerprint: args.fingerprint,
    command: args.spec.command,
    args: args.spec.args,
    envNames: Object.keys(args.spec.env),
    ...(args.changedEnvNames ? { changedEnvNames: args.changedEnvNames } : {}),
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
