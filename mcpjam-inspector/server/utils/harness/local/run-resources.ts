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
import { harnessDisplayName } from "../../../../shared/harness-model-support.js";
import { DEFAULT_LOCAL_HARNESS_ID, localRuntime } from "./runtimes/index.js";

/** Narrow an untrusted harness id to one with a local runtime, or null. */
export function localHarnessIdOf(harness: string | undefined): SupportedLocalHarnessId | null {
  return typeof harness === "string" && (SUPPORTED_LOCAL_HARNESS_IDS as readonly string[]).includes(harness)
    ? (harness as SupportedLocalHarnessId)
    : null;
}

/** Why this machine can't run a harness at all, before the account is asked. */
export type LocalVenueMachineRefusal =
  | "unsupported-harness"
  | "hosted-server"
  | "turned-off"
  | "unsupported-platform"
  | "not-released"
  | "unattended-unverified";

/** A machine reason, or `member`: the account check said no. */
export type LocalVenueRefusal = LocalVenueMachineRefusal | "member";

export type LocalVenueDecision =
  | { venue: "local"; harnessId: SupportedLocalHarnessId }
  | { venue: "hosted"; refusal: LocalVenueRefusal; harnessId: SupportedLocalHarnessId | null };

/**
 * Can THIS Inspector run `harness` on this machine at all — before asking
 * about the account? A supported harness, a local (not hosted) server with the
 * kill switch on, a pack built for this target, lifecycle conformance recorded
 * (or the development override), and — for a harness certified per target
 * (D8) — this target among them. Null when it can; otherwise the first rule
 * that failed, which is what a refusal names.
 *
 * `unattended` (evals and swarms) additionally needs, for a harness whose
 * unattended runs depend on its own command sandbox (Codex, D2), this target
 * among the ones that sandbox was measured on. This is the VENUE decision,
 * made before a launch exists: a run is never started locally and then moved,
 * and a target outside the set simply never selects the local venue for
 * unattended work (preparation refuses it too, independently).
 */
export function localVenueMachineRefusal(
  harness: string | undefined,
  scope: "attended" | "unattended" = "attended",
): LocalVenueMachineRefusal | null {
  const id = localHarnessIdOf(harness);
  if (id === null) return "unsupported-harness";
  if (HOSTED_MODE) return "hosted-server";
  if (!LOCAL_HARNESS_ENABLED) return "turned-off";
  const target = localPackTarget();
  if (target === null || !expectedPackFor(id, target)) return "unsupported-platform";
  const manifest = localHarnessManifestsForDevelopment(LOCAL_HARNESS_MANIFEST)[id];
  if (!manifest?.lifecycleConformanceVersion) return "not-released";
  if (manifest.nativeTargets !== undefined && !manifest.nativeTargets.includes(target)) return "unsupported-platform";
  const sandboxed = manifest.unattendedSandboxTargets;
  return scope === "unattended" && sandboxed !== undefined && !sandboxed.includes(target)
    ? "unattended-unverified"
    : null;
}

export const isLocalHarnessVenue = (
  harness: string | undefined,
  scope: "attended" | "unattended" = "attended",
) => localVenueMachineRefusal(harness, scope) === null;

/**
 * Where `harness` runs for this member and project, and why not here when it
 * can't. The account is asked only once the machine qualifies, exactly as
 * `shouldUseLocalHarness` always has, and its errors propagate unchanged.
 */
export async function decideLocalHarnessVenue(
  harness: string | undefined,
  bearer?: string,
  projectId?: string,
  options: { scope?: "attended" | "unattended" } = {},
): Promise<LocalVenueDecision> {
  const harnessId = localHarnessIdOf(harness);
  const machine = localVenueMachineRefusal(harness, options.scope);
  if (machine !== null || harnessId === null) {
    return { venue: "hosted", refusal: machine ?? "unsupported-harness", harnessId };
  }
  return (await localHarnessAccountEnabled(bearer, projectId, harnessId))
    ? { venue: "local", harnessId }
    : { venue: "hosted", refusal: "member", harnessId };
}

export async function shouldUseLocalHarness(
  harness: string | undefined,
  bearer?: string,
  projectId?: string,
  options: { scope?: "attended" | "unattended" } = {},
) {
  return (await decideLocalHarnessVenue(harness, bearer, projectId, options)).venue === "local";
}

/**
 * The local harnesses this runner will execute UNATTENDED (evals, swarms) for
 * this member and project: machine, conformance, sandbox evidence and the
 * account's own rollout, per harness. `harnesses` narrows the candidates to
 * the ones a launch actually involves; omitted, every local harness.
 *
 * What a launch declares to the backend (`local-harness:<id>`) and what its
 * runner then executes locally both come from this one answer, so the venue
 * the backend stamps is the venue the runner uses.
 */
export async function eligibleUnattendedLocalHarnesses(
  bearer: string | undefined,
  projectId: string | undefined,
  harnesses?: readonly (string | undefined)[],
): Promise<SupportedLocalHarnessId[]> {
  const candidates = harnesses === undefined
    ? [...SUPPORTED_LOCAL_HARNESS_IDS]
    : [...new Set(harnesses.map(localHarnessIdOf).filter((id): id is SupportedLocalHarnessId => id !== null))];
  const eligible: SupportedLocalHarnessId[] = [];
  for (const id of candidates) {
    if (await shouldUseLocalHarness(id, bearer, projectId, { scope: "unattended" })) eligible.push(id);
  }
  return eligible;
}

/**
 * Whether an eval launch from this member may ask for the local venue at all,
 * before its harness is known: some local harness is eligible here. The
 * launch itself then decides per harness (and declares what it decided).
 */
export async function anyUnattendedLocalHarness(
  bearer: string | undefined,
  projectId: string | undefined,
): Promise<boolean> {
  return (await eligibleUnattendedLocalHarnesses(bearer, projectId)).length > 0;
}

/**
 * The harnesses this MACHINE can run unattended, without the account check —
 * for previews that run before a launch's harness is known. A preview may be
 * wider than the launch (the launch re-checks the account and declares only
 * what it will run), never narrower.
 */
export function machineUnattendedLocalHarnesses(): SupportedLocalHarnessId[] {
  return SUPPORTED_LOCAL_HARNESS_IDS.filter((id) => isLocalHarnessVenue(id, "unattended"));
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

export function assertLocalHarnessCapabilities(args: { builtInToolIds?: readonly string[]; computerEnvironmentId?: string; hasAttachments?: boolean; browserToolPolicy?: unknown; harnessId?: string; codeGradingFeatures?: readonly string[] }) {
  if (args.codeGradingFeatures?.length) {
    const name = harnessDisplayName(args.harnessId ?? DEFAULT_LOCAL_HARNESS_ID);
    const features = args.codeGradingFeatures;
    const list = features.length > 1 ? `${features.slice(0, -1).join(", ")} and ${features[features.length - 1]}` : features[0];
    throw new Error(`This suite's ${list} need a cloud sandbox for the agent. Local ${name} runs on your machine, so run this suite with a cloud client.`);
  }
  const unsupported = args.builtInToolIds?.filter(id => ["bash", "browser", "computer", "desktop", "video"].includes(id)) ?? [];
  if (args.computerEnvironmentId || args.hasAttachments || args.browserToolPolicy || unsupported.length) {
    const name = harnessDisplayName(args.harnessId ?? DEFAULT_LOCAL_HARNESS_ID);
    throw new Error(`This client requires cloud computer features. Local ${name} supports its own file and command tools, but cannot use a pinned computer image, seeded attachments, or injected browser/desktop/bash tools.`);
  }
}

/**
 * Git hygiene for an unattended run. A runtime that runs shell commands
 * through Git for Windows (`gitBashOnWindows`) needs Git Bash itself on
 * Windows; one with its own shell needs only a git that honours the per-run
 * config overrides.
 */
async function assertUnattendedGit(harnessId: SupportedLocalHarnessId): Promise<void> {
  const name = harnessDisplayName(harnessId);
  let stdout: string;
  try {
    if (process.platform === "darwin") await promisify(execFile)("/usr/bin/xcode-select", ["-p"], { timeout: 5_000 });
    const gitBash = localRuntime(harnessId).gitBashOnWindows;
    const bash = gitBash ? await resolveGitBashPath(process.platform) : undefined;
    if (process.platform === "win32" && gitBash && !bash) throw new Error("Git for Windows is missing");
    const gitPath = process.platform === "win32"
      ? (bash ? join(dirname(bash), "git.exe") : "git.exe")
      : "/usr/bin/git";
    ({ stdout } = await promisify(execFile)(gitPath, ["--version"], { timeout: 5_000, env: { ...process.env, PATH: process.platform === "win32" ? process.env.PATH : "/usr/bin:/bin" } }));
  } catch { throw new Error(`Local ${name} requires Git 2.31 or newer. Install Git (Command Line Tools on macOS), then retry.`); }
  const version = /git version (\d+)\.(\d+)/.exec(stdout);
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 31)) throw new Error(`Local ${name} requires Git 2.31 or newer. Update Git, then retry.`);
}

export async function prepareLocalHarnessRun(args: { bearer: string; projectId: string; trustedActor?: LocalHarnessActor; harnessId?: SupportedLocalHarnessId }) {
  const harnessId = args.harnessId ?? DEFAULT_LOCAL_HARNESS_ID;
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
