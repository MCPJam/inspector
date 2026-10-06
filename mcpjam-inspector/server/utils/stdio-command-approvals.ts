/**
 * Per-device approval of the command a STDIO server runs (PLB-192).
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
  approvals: Record<string, { fingerprint: string; approvedAt: string }>;
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

export function createStdioCommandApprovalStore(filePath: () => string) {
  const serialize = createCapabilityMutationLock();

  async function readApprovals(): Promise<PersistedApprovals["approvals"]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(filePath(), "utf8"));
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

  function approve(serverId: string, fingerprint: string): Promise<void> {
    return serialize(async () => {
      const file = filePath();
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const release = await lock(file, {
        realpath: false,
        retries: { retries: 40, minTimeout: 25, maxTimeout: 100 },
        stale: 10_000,
      });
      try {
        const approvals = await readApprovals();
        approvals[serverId] = {
          fingerprint,
          approvedAt: new Date().toISOString(),
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
export const readStdioLaunchApproval = defaultStore.read;
export const approveStdioLaunch = defaultStore.approve;

export function stdioCommandApprovalTerms(args: {
  serverId: string;
  spec: StdioLaunchSpec;
  fingerprint: string;
  approval: Exclude<StdioLaunchApproval, "approved">;
}): StdioCommandApprovalTerms {
  return {
    serverId: args.serverId,
    fingerprint: args.fingerprint,
    command: args.spec.command,
    args: args.spec.args,
    envNames: Object.keys(args.spec.env),
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
}): WebRouteError {
  const name = `"${args.serverDisplayName}"`;
  // Shown where no dialog can open (swarms, eval authoring, the environment
  // tools pane): the Servers tab connect is the surface that asks.
  const message =
    args.approval === "changed"
      ? `The command ${name} runs changed since this device approved it. Connect it from Servers to review and approve the new command.`
      : `${name} runs a command this device has not approved yet. Connect it from Servers to review and approve the command.`;
  return new WebRouteError(
    403,
    ErrorCode.STDIO_COMMAND_APPROVAL_REQUIRED,
    message,
    {
      reason: STDIO_COMMAND_APPROVAL_REQUIRED_REASON,
      serverId: args.serverId,
      approval: stdioCommandApprovalTerms(args),
    },
  );
}
