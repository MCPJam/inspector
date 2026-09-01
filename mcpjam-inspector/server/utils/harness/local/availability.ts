/**
 * The single chokepoint that answers "may this turn run a harness on this
 * machine, and with exactly what?"
 *
 * Every gate the design calls for is applied here, in order, and every failure
 * is a named status with a message a user or operator can act on. Nothing
 * downstream re-decides: a caller either gets a fully resolved launch plan or
 * gets a refusal. In particular there is no path that answers "not quite —
 * run it hosted instead" on its own; silently relocating a turn the user
 * deliberately scoped to their machine is the dishonesty this whole design
 * removes, so the caller is told what failed and decides.
 *
 * Order matters, cheapest and most absolute first:
 *
 *   1. server kill switch and hosted mode — an operator's off switch, and the
 *      structural rule that a hosted replica never executes locally;
 *   2. actor eligibility — guests, share-link scenario sessions, journey and
 *      swarm sessions are never attended users consenting to their own
 *      machine, so they can never reach local execution;
 *   3. compatibility — harness, platform, target mode, permission profile,
 *      adapter version, conformance evidence;
 *   4. workspace grant — an opaque id resolved to a canonical path, re-checked
 *      against symlink replacement;
 *   5. runtime identity — the managed bundle re-digested, or the system
 *      executable re-hashed;
 *   6. consent — a capability bound to every one of the identities above.
 *
 * Consent is verified LAST and against the identities the earlier steps
 * actually resolved, not against what the caller claimed. That ordering is the
 * point: a grant can only match terms that were independently re-derived.
 */
import { HOSTED_MODE, LOCAL_HARNESS_ENABLED } from "../../../config.js";
import {
  resolveLocalCompatibility,
  type LocalCompatibilityStatus,
  type LocalHarnessCompatibility,
  LOCAL_HARNESS_MANIFEST,
} from "./compatibility.js";
import {
  resolveWorkspaceGrant,
  verifyLocalHarnessGrant,
  type HarnessGrantBinding,
} from "./grants.js";
import {
  resolveManagedBundle,
  resolveSystemInstall,
  revalidateRuntime,
  type ResolvedRuntime,
} from "./runtime-identity.js";
import {
  currentLocalPlatform,
  LOCAL_HARNESS_POLICY_VERSION,
  type LocalHarnessExecutionTarget,
} from "./targets.js";
import { supportsOwnershipProof } from "./process-identity.js";

export type LocalHarnessUnavailableStatus =
  | "server-disabled"
  | "hosted"
  | "actor-not-eligible"
  | "ownership-unprovable"
  | "workspace-grant-invalid"
  | "runtime-unavailable"
  | "runtime-changed"
  | "consent-required"
  | LocalCompatibilityStatus;

export interface LocalHarnessLaunchPlan {
  target: LocalHarnessExecutionTarget;
  manifest: LocalHarnessCompatibility;
  runtime: ResolvedRuntime;
  /** Canonical workspace path. Local trusted state — never leaves this process
   *  and never reaches a renderer or telemetry. */
  workspacePath: string;
  /** The SDK permission mode this profile maps to for this harness. Always
   *  explicit; the SDK's `allow-all` default is never inherited. */
  permissionMode: "allow-reads" | "allow-edits" | "allow-all";
  grantId: string;
}

export type LocalHarnessAvailability =
  | { available: true; plan: LocalHarnessLaunchPlan }
  | {
      available: false;
      status: LocalHarnessUnavailableStatus;
      message: string;
    };

/**
 * Actor shape, mirroring `computers/engine.ts`'s eligibility rule so the two
 * local paths cannot drift into disagreeing about who counts as an attended
 * user on their own machine.
 */
export interface LocalHarnessActor {
  isGuest: boolean;
  isScenarioSession: boolean;
  isJourneySession: boolean;
  executionScopeKind?: "project" | "swarm" | undefined;
}

export function isActorEligibleForLocalHarness(
  actor: LocalHarnessActor
): boolean {
  return (
    !actor.isGuest &&
    !actor.isScenarioSession &&
    !actor.isJourneySession &&
    (actor.executionScopeKind === undefined ||
      actor.executionScopeKind === "project")
  );
}

export interface LocalHarnessAvailabilityQuery {
  target: LocalHarnessExecutionTarget;
  actor: LocalHarnessActor;
  userId: string;
  projectId: string;
  /** Plaintext capability from the request header; never persisted. */
  grantToken: string | null | undefined;
  /** Root holding per-harness managed bundles. */
  runtimeRoot: string;
  /** Installed adapter version, read from the package at call time. */
  installedAdapterVersion?: string;
  /** Test seams. */
  manifests?: Readonly<Record<string, LocalHarnessCompatibility>>;
  platform?: NodeJS.Platform;
  killSwitchEnabled?: boolean;
  hosted?: boolean;
}

function unavailable(
  status: LocalHarnessUnavailableStatus,
  message: string
): LocalHarnessAvailability {
  return { available: false, status, message };
}

export async function resolveLocalHarnessAvailability(
  query: LocalHarnessAvailabilityQuery
): Promise<LocalHarnessAvailability> {
  const hosted = query.hosted ?? HOSTED_MODE;
  const enabled = query.killSwitchEnabled ?? LOCAL_HARNESS_ENABLED;
  const platform = query.platform ?? process.platform;

  if (hosted) {
    return unavailable(
      "hosted",
      "a hosted Inspector never runs a harness on its own machine"
    );
  }
  if (!enabled) {
    return unavailable(
      "server-disabled",
      "local harness execution is disabled on this server " +
        "(MCPJAM_LOCAL_HARNESS_ENABLED)"
    );
  }
  if (!isActorEligibleForLocalHarness(query.actor)) {
    return unavailable(
      "actor-not-eligible",
      "local execution requires an attended, signed-in member running their " +
        "own turn. Guests, shared scenario sessions, and swarm-scoped runs " +
        "run hosted."
    );
  }
  if (!supportsOwnershipProof(platform)) {
    return unavailable(
      "ownership-unprovable",
      `this Inspector cannot prove ownership of a process tree on ${platform}, ` +
        `so it could not guarantee that stopping a session stops everything it ` +
        `started`
    );
  }

  const target = query.target;
  const compatibility = resolveLocalCompatibility(
    {
      harnessId: target.harnessId,
      platform: currentLocalPlatform(platform),
      targetKind: target.kind,
      permissionProfile: target.permissionProfile,
      ...(target.kind === "local-isolated" ? { backend: target.backend } : {}),
      ...(query.installedAdapterVersion !== undefined
        ? { installedAdapterVersion: query.installedAdapterVersion }
        : {}),
    },
    query.manifests ?? LOCAL_HARNESS_MANIFEST
  );
  if (!compatibility.ok) {
    return unavailable(compatibility.status, compatibility.message);
  }

  const workspace = await resolveWorkspaceGrant(target.workspaceGrantId);
  if (!workspace.ok) {
    return unavailable("workspace-grant-invalid", workspace.message);
  }

  const runtimeResolution =
    compatibility.manifest.runtime.source === "managed-bundle"
      ? await resolveManagedBundle({
          manifest: compatibility.manifest,
          runtimeRoot: query.runtimeRoot,
          platform: currentLocalPlatform(platform)!,
        })
      : await resolveSystemInstall({
          manifest: compatibility.manifest,
          platform: currentLocalPlatform(platform)!,
          // The workspace is writable by the very agent we are about to start,
          // so a runtime discovered inside it is not a runtime we can hold.
          forbiddenRoots: [workspace.canonicalPath],
        });
  if (!runtimeResolution.ok) {
    return unavailable("runtime-unavailable", runtimeResolution.message);
  }

  // Consent named a runtime; prove the thing on disk is still that runtime.
  const revalidated = await revalidateRuntime(runtimeResolution.runtime);
  if (!revalidated.ok) {
    return unavailable("runtime-changed", revalidated.message);
  }
  if (runtimeResolution.runtime.runtimeId !== target.runtimeId) {
    return unavailable(
      "runtime-changed",
      "the resolved runtime is not the one this target names; consent is " +
        "bound to a runtime identity, so it must be re-granted"
    );
  }

  const binding: HarnessGrantBinding = {
    userId: query.userId,
    machineId: target.machineId,
    projectId: query.projectId,
    workspaceGrantId: target.workspaceGrantId,
    harnessId: target.harnessId,
    targetKind: target.kind,
    ...(target.kind === "local-isolated" ? { backend: target.backend } : {}),
    runtimeId: runtimeResolution.runtime.runtimeId,
    permissionProfile: target.permissionProfile,
    policyVersion:
      target.kind === "local-native"
        ? target.policyVersion
        : LOCAL_HARNESS_POLICY_VERSION,
  };
  const consent = await verifyLocalHarnessGrant(query.grantToken, binding);
  if (!consent.ok) {
    return unavailable("consent-required", consent.message);
  }

  return {
    available: true,
    plan: {
      target,
      manifest: compatibility.manifest,
      runtime: runtimeResolution.runtime,
      workspacePath: workspace.canonicalPath,
      permissionMode: compatibility.permissionMode,
      grantId: consent.grantId,
    },
  };
}
