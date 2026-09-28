import type { LocalHarnessActor } from "./acting-user.js";
import { stopLocalHarnessWorkspace } from "./session-registry.js";
import { sessionStateDirFor } from "./supervised-provider.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { HOSTED_MODE } from "../../../config.js";
import { ensureLocalHarnessTarget } from "./readiness.js";
import { localHarnessStateRoot, registerWorkspaceGrant, forgetWorkspaceGrant } from "./grants.js";
import { mkdir } from "node:fs/promises";

export const isLocalHarnessVenue = (harness: string | undefined) => !HOSTED_MODE && harness === "claude-code";

/** All schedulers share these slots; waiting happens before iteration deadlines. */
let active = 0;
const waiters: Array<() => void> = [];
export async function withLocalHarnessSlot<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw signal.reason;
  if (active >= 2) await new Promise<void>((resolve, reject) => {
    const ready = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const abort = () => {
      const index = waiters.indexOf(ready);
      if (index >= 0) waiters.splice(index, 1);
      reject(signal?.reason);
    };
    waiters.push(ready);
    signal?.addEventListener("abort", abort, { once: true });
  });
  else active++;
  try { if (signal?.aborted) throw signal.reason; return await run(); }
  finally { const next = waiters.shift(); if (next) next(); else active--; }
}

export function assertLocalHarnessCapabilities(args: { builtInToolIds?: readonly string[]; computerEnvironmentId?: string; hasAttachments?: boolean; browserToolPolicy?: unknown }) {
  const unsupported = args.builtInToolIds?.filter(id => ["bash", "browser", "computer", "desktop", "video"].includes(id)) ?? [];
  if (args.computerEnvironmentId || args.hasAttachments || args.browserToolPolicy || unsupported.length) {
    throw new Error("This client requires cloud computer features. Local Claude Code supports its own file and command tools, but cannot use a pinned computer image, seeded attachments, or injected browser/desktop/bash tools.");
  }
}

export async function prepareLocalHarnessRun(args: { bearer: string; projectId: string; trustedActor?: LocalHarnessActor }) {
  const { stdout } = await promisify(execFile)("git", ["--version"], { timeout: 5_000 });
  const version = /git version (\d+)\.(\d+)/.exec(stdout);
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 31)) throw new Error("Unattended local Claude Code requires Git 2.31 or newer");
  const root = join(localHarnessStateRoot(), "scratch");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "run-"));
  let workspaceGrantId: string | undefined;
  try {
    const workspace = await registerWorkspaceGrant(directory);
    if (!workspace.ok) throw new Error(workspace.message);
    workspaceGrantId = workspace.grant.workspaceGrantId;
    const ready = await ensureLocalHarnessTarget({ ...args, scope: "unattended", workspaceGrantId });
    const localSessionId = `local-${randomUUID()}`;
    return { target: { ...ready.target, localSessionId }, cleanup: async () => {
      if (!(await stopLocalHarnessWorkspace(workspace.grant.workspaceGrantId))) throw new Error("A Claude Code process could not be stopped; its workspace was retained");
      await rm(sessionStateDirFor(localHarnessStateRoot(), localSessionId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await forgetWorkspaceGrant(workspace.grant.workspaceGrantId);
    } };
  } catch (error) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (workspaceGrantId) await forgetWorkspaceGrant(workspaceGrantId);
    throw error;
  }
}
