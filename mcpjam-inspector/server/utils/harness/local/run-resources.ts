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
import { localPackTarget, SUPPORTED_LOCAL_HARNESS_IDS, type SupportedLocalHarnessId } from "./targets.js";
import { LOCAL_HARNESS_MANIFEST } from "./compatibility.js";
import { localHarnessManifestsForDevelopment } from "./availability.js";
import { localHarnessAccountEnabled } from "./readiness.js";
import { scratchRoot, recordScratchOwner, forgetScratchOwner } from "./scratch-janitor.js";
import { logger } from "../../logger.js";

/** Narrow an untrusted harness id to one with a local runtime, or null. */
export function localHarnessIdOf(harness: string | undefined): SupportedLocalHarnessId | null {
  return typeof harness === "string" && (SUPPORTED_LOCAL_HARNESS_IDS as readonly string[]).includes(harness)
    ? (harness as SupportedLocalHarnessId)
    : null;
}

/**
 * Can THIS Inspector run `harness` on this machine at all — before asking
 * about the account? A supported harness, a local (not hosted) server with the
 * kill switch on, a pack built for this target, lifecycle conformance recorded
 * (or the development override), and — for a harness certified per target
 * (D8) — this target among them.
 *
 * `unattended` (evals and swarms) additionally needs, for a harness whose
 * unattended runs depend on its own command sandbox (Codex, D2), this target
 * among the ones that sandbox was measured on. This is the VENUE decision,
 * made before a launch exists: a run is never started locally and then moved,
 * and a target outside the set simply never selects the local venue for
 * unattended work (preparation refuses it too, independently).
 */
export const isLocalHarnessVenue = (
  harness: string | undefined,
  scope: "attended" | "unattended" = "attended",
) => {
  const id = localHarnessIdOf(harness);
  if (id === null || HOSTED_MODE || !LOCAL_HARNESS_ENABLED) return false;
  const target = localPackTarget();
  if (target === null || !expectedPackFor(id, target)) return false;
  const manifest = localHarnessManifestsForDevelopment(LOCAL_HARNESS_MANIFEST)[id];
  if (!manifest?.lifecycleConformanceVersion) return false;
  if (manifest.nativeTargets !== undefined && !manifest.nativeTargets.includes(target)) return false;
  return (
    scope === "attended" ||
    manifest.unattendedSandboxTargets === undefined ||
    manifest.unattendedSandboxTargets.includes(target)
  );
};
export async function shouldUseLocalHarness(
  harness: string | undefined,
  bearer?: string,
  projectId?: string,
  options: { scope?: "attended" | "unattended" } = {},
) {
  const id = localHarnessIdOf(harness);
  return id !== null && isLocalHarnessVenue(id, options.scope) && await localHarnessAccountEnabled(bearer, projectId, id);
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

export function assertLocalHarnessCapabilities(args: { builtInToolIds?: readonly string[]; computerEnvironmentId?: string; hasAttachments?: boolean; browserToolPolicy?: unknown; harnessId?: string }) {
  const unsupported = args.builtInToolIds?.filter(id => ["bash", "browser", "computer", "desktop", "video"].includes(id)) ?? [];
  if (args.computerEnvironmentId || args.hasAttachments || args.browserToolPolicy || unsupported.length) {
    const name = args.harnessId === "codex" ? "Codex" : "Claude Code";
    throw new Error(`This client requires cloud computer features. Local ${name} supports its own file and command tools, but cannot use a pinned computer image, seeded attachments, or injected browser/desktop/bash tools.`);
  }
}

/**
 * Git hygiene for an unattended run. Claude Code runs its Bash tool through
 * Git for Windows, so on Windows it needs Git Bash itself; Codex runs its own
 * shell and needs only a git that honours the per-run config overrides.
 */
async function assertUnattendedGit(harnessId: SupportedLocalHarnessId): Promise<void> {
  const name = harnessId === "codex" ? "Codex" : "Claude Code";
  let stdout: string;
  try {
    if (process.platform === "darwin") await promisify(execFile)("/usr/bin/xcode-select", ["-p"], { timeout: 5_000 });
    const bash = harnessId === "claude-code" ? await resolveGitBashPath(process.platform) : undefined;
    if (process.platform === "win32" && harnessId === "claude-code" && !bash) throw new Error("Git for Windows is missing");
    const gitPath = process.platform === "win32"
      ? (bash ? join(dirname(bash), "git.exe") : "git.exe")
      : "/usr/bin/git";
    ({ stdout } = await promisify(execFile)(gitPath, ["--version"], { timeout: 5_000, env: { ...process.env, PATH: process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin" } }));
  } catch { throw new Error(`Local ${name} requires Git 2.31 or newer. Install Git (Command Line Tools on macOS), then retry.`); }
  const version = /git version (\d+)\.(\d+)/.exec(stdout);
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 31)) throw new Error(`Unattended local ${name} requires Git 2.31 or newer`);
}

export async function prepareLocalHarnessRun(args: { bearer: string; projectId: string; trustedActor?: LocalHarnessActor; harnessId?: SupportedLocalHarnessId }) {
  const harnessId = args.harnessId ?? "claude-code";
  await assertUnattendedGit(harnessId);
  const root = scratchRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, "run-"));
  let workspaceGrantId: string | undefined;
  try {
    const workspace = await registerWorkspaceGrant(directory);
    if (!workspace.ok) throw new Error(workspace.message);
    workspaceGrantId = workspace.grant.workspaceGrantId;
    await recordScratchOwner(basename(directory), workspaceGrantId);
    const ready = await ensureLocalHarnessTarget({ ...args, harnessId, scope: "unattended", workspaceGrantId });
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
