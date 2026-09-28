/** Shared setup and launch authorization for every local Claude Code surface. */
import { ConvexHttpClient } from "convex/browser";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOSTED_MODE, LOCAL_HARNESS_ENABLED } from "../../../config.js";
import { resolveLocalHarnessActor, type LocalHarnessActor } from "./acting-user.js";
import { authorizeLocalHarness, readLocalHarnessAuthorization } from "./authorization.js";
import { getLocalMachineId, grantLocalHarnessConsent, localHarnessStateRoot, registerWorkspaceGrant, resolveWorkspaceGrant } from "./grants.js";
import { readRuntimeInstallStatus, installRuntimePack, startRuntimeInstall, manifestWithExpectedBundleDigest } from "./runtime-install.js";
import { resolveManagedBundle } from "./runtime-identity.js";
import { LOCAL_HARNESS_MANIFEST } from "./compatibility.js";
import { localHarnessManifestsForDevelopment } from "./availability.js";
import { currentLocalPlatform, localPackTarget, LOCAL_HARNESS_POLICY_VERSION } from "./targets.js";
import { readLocalInstanceIdentity, setRegisteredKeyId } from "./instance-key.js";
import { registerLocalInstance } from "../harness-model-broker.js";
import { resolveSuggestedWorkspace } from "./suggested-workspace.js";
import { evaluateLocalHarnessRollout } from "../../analytics.js";
import type { LocalHarnessExecutionTarget } from "./local-turn.js";

export function localHarnessBackend(bearer: string) {
  const url = process.env.CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL is not configured");
  const client = new ConvexHttpClient(url);
  client.setAuth(bearer.replace(/^Bearer\s+/i, ""));
  return client;
}
export async function verifyLocalHarnessMember(bearer: string, projectId: string, trustedActor?: LocalHarnessActor) {
  if (HOSTED_MODE || !LOCAL_HARNESS_ENABLED) throw new Error("Local Claude Code is unavailable on this server");
  const actor = trustedActor ? { ok: true as const, actor: trustedActor } : await resolveLocalHarnessActor({ authorizationHeader: `Bearer ${bearer.replace(/^Bearer\s+/i, "")}`, contextCredential: null });
  if (!actor.ok) throw new Error(actor.message);
  const client = localHarnessBackend(bearer);
  const [projects, user] = await Promise.all([
    client.query("projects:getMyProjects" as never, {}),
    client.query("users:getCurrentUser" as never, {}),
  ]) as [Array<{ _id: string }>, { email?: string; externalId?: string } | null];
  if (trustedActor && user?.externalId !== trustedActor.subject) throw new Error("Background execution identity changed");
  if (!Array.isArray(projects) || !projects.some(p => String(p._id) === projectId)) throw new Error("Project membership is required for local execution");
  if (!(await evaluateLocalHarnessRollout(actor.actor.subject, user?.email))) throw new Error("Local Claude Code is not available for this account yet");
  return actor.actor;
}

export class LocalRuntimePreparingError extends Error {}

export async function setupLocalHarness(args: { bearer: string; projectId: string; workspacePath?: string; waitForInstall?: boolean }) {
  const actor = await verifyLocalHarnessMember(args.bearer, args.projectId);
  const machineId = await getLocalMachineId();
  let path = args.workspacePath;
  if (!path) path = (await resolveSuggestedWorkspace({ displayRoot: value => value }))?.canonicalPath;
  if (!path) {
    path = join(localHarnessStateRoot(), "workspaces", createHash("sha256").update(args.projectId).digest("hex").slice(0, 24));
    await mkdir(path, { recursive: true, mode: 0o700 });
  }
  const workspace = await registerWorkspaceGrant(path);
  if (!workspace.ok) throw new Error(workspace.message);
  // Persist intent before downloading so reload/restart can safely finish setup.
  await authorizeLocalHarness({ userId: actor.userId, machineId, projectId: args.projectId, workspaceGrantId: workspace.grant.workspaceGrantId });
  return ensureLocalHarnessTarget({ ...args, scope: "attended" });
}

export async function ensureLocalHarnessTarget(args: {
  bearer: string; projectId: string; scope: "attended" | "unattended";
  /** Registered session-owned scratch grant; supplied only by trusted schedulers. */
  workspaceGrantId?: string;
  waitForInstall?: boolean;
  /** Verified once at the signed-in launch; only trusted schedulers pass this. */
  trustedActor?: LocalHarnessActor;
}) {
  const actor = await verifyLocalHarnessMember(args.bearer, args.projectId, args.trustedActor);
  const machineId = await getLocalMachineId();
  const authorization = await readLocalHarnessAuthorization(actor.userId, machineId, args.projectId);
  if (!authorization) throw new Error("Set up Claude Code from Add client to allow it to run on this computer");
  let status = await readRuntimeInstallStatus({ harnessId: "claude-code" });
  if (status.state !== "ready") {
    if (args.waitForInstall === false) {
      const started = await startRuntimeInstall({ harnessId: "claude-code" });
      if (started.kind !== "ready" && started.kind !== "refused") throw new LocalRuntimePreparingError("Installing Claude Code");
      status = started.status;
    } else status = await installRuntimePack({ harnessId: "claude-code" });
  }
  if (status.state !== "ready") throw new Error(`Claude Code installation is ${status.state}. Retry setup when the runtime is available.`);
  const platform = currentLocalPlatform(process.platform);
  if (!platform) throw new Error("This platform is not supported by local Claude Code");
  const runtime = await resolveManagedBundle({
    manifest: manifestWithExpectedBundleDigest(localHarnessManifestsForDevelopment(LOCAL_HARNESS_MANIFEST)["claude-code"], "claude-code", localPackTarget()),
    runtimeRoot: status.runtimeRoot, platform,
  });
  if (!runtime.ok) throw new Error(runtime.message);
  const workspaceGrantId = args.workspaceGrantId ?? authorization.workspaceGrantId;
  const workspace = await resolveWorkspaceGrant(workspaceGrantId);
  if (!workspace.ok) throw new Error(workspace.message);
  const identity = await readLocalInstanceIdentity();
  const registration = await registerLocalInstance({ machineId, publicKey: identity.publicKey, bearer: args.bearer });
  if (!registration.ok) throw new Error(registration.error);
  setRegisteredKeyId(registration.keyId);
  const permissionProfile = args.scope === "unattended" ? "unrestricted" : "workspace-edits";
  const granted = await grantLocalHarnessConsent({
    userId: actor.userId, machineId, projectId: args.projectId, workspaceGrantId,
    harnessId: "claude-code", targetKind: "local-native", runtimeId: runtime.runtime.runtimeId,
    permissionProfile, policyVersion: LOCAL_HARNESS_POLICY_VERSION, scope: args.scope,
  });
  return { grantId: granted.grantId, expiresAt: granted.expiresAt,
    workspaceDisplayRoot: (workspace.canonicalPath === homedir() || workspace.canonicalPath.startsWith(`${homedir()}/`)) ? `~${workspace.canonicalPath.slice(homedir().length)}` : workspace.canonicalPath,
    runtime: { runtimeId: runtime.runtime.runtimeId, adapterVersion: runtime.runtime.adapterVersion, digest: runtime.runtime.digest, packVersion: status.packVersion },
    target: {
    kind: "local-native", machineId, workspaceGrantId, runtimeId: runtime.runtime.runtimeId,
    permissionProfile, policyVersion: LOCAL_HARNESS_POLICY_VERSION, grantToken: granted.token, actingUserId: actor.userId,
  } satisfies LocalHarnessExecutionTarget };
}
