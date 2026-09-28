import type { LocalHarnessActor } from "./acting-user.js";
import { stopLocalHarnessWorkspace } from "./session-registry.js";
import { sessionStateDirFor, resolveGitBashPath } from "./supervised-provider.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { HOSTED_MODE, LOCAL_HARNESS_ENABLED } from "../../../config.js";
import { ensureLocalHarnessTarget } from "./readiness.js";
import { localHarnessStateRoot, registerWorkspaceGrant, forgetWorkspaceGrant } from "./grants.js";
import { mkdir } from "node:fs/promises";

import { expectedPackFor } from "./runtime-install.js";
import { localPackTarget } from "./targets.js";
import { LOCAL_HARNESS_MANIFEST } from "./compatibility.js";
import { localHarnessManifestsForDevelopment } from "./availability.js";
import { localHarnessAccountEnabled } from "./readiness.js";
import { scratchRoot, recordScratchOwner, forgetScratchOwner } from "./scratch-janitor.js";
import { logger } from "../../logger.js";

export const isLocalHarnessVenue = (harness: string | undefined) => {
  if (harness !== "claude-code" || HOSTED_MODE || !LOCAL_HARNESS_ENABLED) return false;
  const target = localPackTarget();
  return target !== null &&
    Boolean(expectedPackFor("claude-code", target)) &&
    Boolean(localHarnessManifestsForDevelopment(LOCAL_HARNESS_MANIFEST)["claude-code"].lifecycleConformanceVersion);
};
export async function shouldUseLocalHarness(harness: string | undefined, bearer?: string, projectId?: string) {
  return isLocalHarnessVenue(harness) && await localHarnessAccountEnabled(bearer, projectId);
}

/** All schedulers share these slots; waiting happens before iteration deadlines. */
let active = 0;
const waiters: Array<() => void> = [];
export async function acquireLocalHarnessSlot(signal?: AbortSignal): Promise<() => void> {
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
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const next = waiters.shift();
    if (next) next(); else active--;
  };
  if (signal?.aborted) { release(); throw signal.reason; }
  return release;
}

export async function withLocalHarnessSlot<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const release = await acquireLocalHarnessSlot(signal);
  try { return await run(); }
  finally { release(); }
}

export function assertLocalHarnessCapabilities(args: { builtInToolIds?: readonly string[]; computerEnvironmentId?: string; hasAttachments?: boolean; browserToolPolicy?: unknown }) {
  const unsupported = args.builtInToolIds?.filter(id => ["bash", "browser", "computer", "desktop", "video"].includes(id)) ?? [];
  if (args.computerEnvironmentId || args.hasAttachments || args.browserToolPolicy || unsupported.length) {
    throw new Error("This client requires cloud computer features. Local Claude Code supports its own file and command tools, but cannot use a pinned computer image, seeded attachments, or injected browser/desktop/bash tools.");
  }
}

export async function prepareLocalHarnessRun(args: { bearer: string; projectId: string; trustedActor?: LocalHarnessActor }) {
  let stdout: string;
  try {
    if (process.platform === "darwin") await promisify(execFile)("/usr/bin/xcode-select", ["-p"], { timeout: 5_000 });
    const bash = await resolveGitBashPath(process.platform);
    if (process.platform === "win32" && !bash) throw new Error("Git for Windows is missing");
    ({ stdout } = await promisify(execFile)(process.platform === "win32" ? join(dirname(bash!), "git.exe") : "/usr/bin/git", ["--version"], { timeout: 5_000, env: { ...process.env, PATH: process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin" } }));
  } catch { throw new Error("Local Claude Code requires Git 2.31 or newer. Install Git (Command Line Tools on macOS), then retry."); }
  const version = /git version (\d+)\.(\d+)/.exec(stdout);
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 31)) throw new Error("Unattended local Claude Code requires Git 2.31 or newer");
  const root = scratchRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "run-"));
  let workspaceGrantId: string | undefined;
  try {
    const workspace = await registerWorkspaceGrant(directory);
    if (!workspace.ok) throw new Error(workspace.message);
    workspaceGrantId = workspace.grant.workspaceGrantId;
    await recordScratchOwner(basename(directory), workspaceGrantId);
    const ready = await ensureLocalHarnessTarget({ ...args, scope: "unattended", workspaceGrantId });
    const localSessionId = `local-${randomUUID()}`;
    return { target: { ...ready.target, localSessionId }, cleanup: async () => {
      try {
      if (!(await stopLocalHarnessWorkspace(workspace.grant.workspaceGrantId))) { logger.warn("[local-harness] Process did not stop; retaining workspace"); return; }
      await rm(sessionStateDirFor(localHarnessStateRoot(), localSessionId), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      await forgetWorkspaceGrant(workspace.grant.workspaceGrantId);
      await forgetScratchOwner(basename(directory));
      } catch (error) { logger.warn("[local-harness] Workspace cleanup failed", { error: String(error) }); }
    } };
  } catch (error) {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (workspaceGrantId) await forgetWorkspaceGrant(workspaceGrantId);
    await forgetScratchOwner(basename(directory));
    throw error;
  }
}
