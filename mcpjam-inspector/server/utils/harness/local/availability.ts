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
  getLocalMachineId,
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
  localPackTarget,
  LOCAL_HARNESS_POLICY_VERSION,
  type LocalHarnessExecutionTarget,
} from "./targets.js";
import { isSelectablePack, manifestWithExpectedBundleDigest } from "./runtime-install.js";
import { supportsOwnershipProof } from "./process-identity.js";

export type LocalHarnessUnavailableStatus =
  | "server-disabled"
  | "hosted"
  | "actor-not-eligible"
  | "machine-identity-unavailable"
  | "machine-mismatch"
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
  actor: LocalHarnessActor,
  scope: "attended" | "unattended" = "attended",
): boolean {
  return (
    !actor.isGuest &&
    !actor.isScenarioSession &&
    (scope === "unattended" || (!actor.isJourneySession &&
    (actor.executionScopeKind === undefined ||
      actor.executionScopeKind === "project")))
  );
}

export interface LocalHarnessAvailabilityQuery {
  target: LocalHarnessExecutionTarget;
  actor: LocalHarnessActor;
  scope?: "attended" | "unattended";
  userId: string;
  projectId: string;
  /** Plaintext capability from the request header; never persisted. */
  grantToken: string | null | undefined;
  /** Root holding per-harness managed bundles. */
  runtimeRoot: string;
  /** Installed adapter version, read from the package at call time. Required:
   *  a caller that cannot state it cannot be allowed to skip the exact pin. */
  installedAdapterVersion: string;
  /**
   * The tree digest of the pack the caller SELECTED (`readRuntimeInstallStatus`)
   * — the desired pack or the permitted previous one. Refused unless this
   * build may select it and it is not revoked (invariant 4). Absent: the
   * desired pack.
   */
  runtimeDigest?: string;
  /** Test seams. */
  localMachineId?: string;
  manifests?: Readonly<Record<string, LocalHarnessCompatibility>>;
  platform?: NodeJS.Platform;
  killSwitchEnabled?: boolean;
  hosted?: boolean;
}

function unavailable(
  status: LocalHarnessUnavailableStatus,
  message: string,
): LocalHarnessAvailability {
  return { available: false, status, message };
}

/** Development-only evidence for exercising an unpublished runtime pack. */
export function localHarnessManifestsForDevelopment(
  manifests: Readonly<Record<string, LocalHarnessCompatibility>> = LOCAL_HARNESS_MANIFEST,
): Readonly<Record<string, LocalHarnessCompatibility>> {
  const version = process.env.MCPJAM_LOCAL_HARNESS_CONFORMANCE_VERSION?.trim();
  if (HOSTED_MODE || process.env.ENVIRONMENT !== "dev" || !version) {
    return manifests;
  }
  return Object.fromEntries(
    Object.entries(manifests).map(([id, manifest]) => [
      id,
      // Every harness the manifest names, not only Claude Code: an unpublished
      // Codex pack has to be exercisable through the same override before its
      // conformance is recorded. Development builds only (see above).
      manifest.lifecycleConformanceVersion
        ? manifest
        : { ...manifest, lifecycleConformanceVersion: version },
    ]),
  );
}

export async function resolveLocalHarnessAvailability(
  query: LocalHarnessAvailabilityQuery,
): Promise<LocalHarnessAvailability> {
  const hosted = query.hosted ?? HOSTED_MODE;
  const enabled = query.killSwitchEnabled ?? LOCAL_HARNESS_ENABLED;
  const platform = query.platform ?? process.platform;

  if (hosted) {
    return unavailable(
      "hosted",
      "a hosted Inspector never runs a harness on its own machine",
    );
  }
  if (!enabled) {
    return unavailable(
      "server-disabled",
      "local harness execution is disabled on this server " +
        "(MCPJAM_LOCAL_HARNESS_ENABLED)",
    );
  }
  if (!isActorEligibleForLocalHarness(query.actor, query.scope)) {
    return unavailable(
      "actor-not-eligible",
      "local execution requires an attended, signed-in member running their " +
        "own turn. Guests, shared scenario sessions, and swarm-scoped runs " +
        "run hosted.",
    );
  }
  // A target names the machine it was consented on. Without this check the
  // gate would happily accept one minted for a different installation, and the
  // consent binding below would then be compared against a machine id the
  // caller chose rather than the one this Inspector actually is.
  let localMachineId: string;
  try {
    localMachineId = query.localMachineId ?? (await getLocalMachineId());
  } catch (error) {
    // Minting or reading the machine id touches owner-only local state. If
    // that fails we cannot say which machine this is, so the gate refuses by
    // name rather than rejecting out of a function whose contract is to return
    // a decision.
    return unavailable(
      "machine-identity-unavailable",
      `this Inspector could not establish its local machine identity, so a ` +
        `machine-scoped consent grant cannot be checked: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (query.target.machineId !== localMachineId) {
    return unavailable(
      "machine-mismatch",
      "this local execution target was granted on a different machine; " +
        "consent is per-installation and must be granted again here",
    );
  }

  if (!supportsOwnershipProof(platform)) {
    return unavailable(
      "ownership-unprovable",
      `this Inspector cannot prove ownership of a process tree on ${platform}, ` +
        `so it could not guarantee that stopping a session stops everything it ` +
        `started`,
    );
  }

  const target = query.target;
  const compatibility = resolveLocalCompatibility(
    {
      scope: query.scope,
      harnessId: target.harnessId,
      platform: currentLocalPlatform(platform),
      targetKind: target.kind,
      permissionProfile: target.permissionProfile,
      ...(target.kind === "local-isolated" ? { backend: target.backend } : {}),
      // The exact pack target, so a manifest certified per architecture (D8)
      // refuses an uncertified one rather than trusting the OS alone.
      packTarget: localPackTarget(platform),
      installedAdapterVersion: query.installedAdapterVersion,
    },
    query.manifests ?? localHarnessManifestsForDevelopment(),
  );
  if (!compatibility.ok) {
    return unavailable(compatibility.status, compatibility.message);
  }

  const workspace = await resolveWorkspaceGrant(target.workspaceGrantId);
  if (!workspace.ok) {
    return unavailable("workspace-grant-invalid", workspace.message);
  }

  // A selected pack must be one this build may select: its desired pack or
  // its one permitted previous pack, and never a revoked one. Conformance
  // runners that pass their own manifests name the pack under test instead.
  const packTarget = localPackTarget(platform);
  if (
    query.runtimeDigest !== undefined &&
    query.manifests === undefined &&
    compatibility.manifest.runtime.source === "managed-bundle" &&
    packTarget !== null
  ) {
    const selectable = await isSelectablePack(compatibility.manifest.harnessId, packTarget, query.runtimeDigest);
    if (!selectable.ok) return unavailable("runtime-unavailable", selectable.message);
  }

  const runtimeResolution =
    compatibility.manifest.runtime.source === "managed-bundle"
      ? await resolveManagedBundle({
          // Through `manifestWithExpectedBundleDigest`, so this path verifies
          // against the digest the INSTALLER accepted rather than a second
          // reading of the same table. They differ only under the documented
          // development override — and there they differed fatally: a locally
          // built pack installed and then could never run.
          //
          // EXCEPT for a caller that supplied its own manifests (the
          // conformance runners): their manifest names the pack under test,
          // and replacing its digest with the pinned one made a pack built
          // from changed inputs — exactly what a pack-input change or a new
          // pack's pre-pin conformance has to run — unrunnable.
          manifest:
            query.manifests !== undefined
              ? compatibility.manifest
              : manifestWithExpectedBundleDigest(
                  compatibility.manifest,
                  compatibility.manifest.harnessId,
                  packTarget,
                  query.runtimeDigest,
                ),
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
        "bound to a runtime identity, so it must be re-granted",
    );
  }

  const binding: HarnessGrantBinding = {
    scope: query.scope ?? "attended",
    userId: query.userId,
    machineId: target.machineId,
    projectId: query.projectId,
    workspaceGrantId: target.workspaceGrantId,
    harnessId: target.harnessId,
    targetKind: target.kind,
    ...(target.kind === "local-isolated" ? { backend: target.backend } : {}),
    runtimeId: runtimeResolution.runtime.runtimeId,
    permissionProfile: target.permissionProfile,
    // Every local target carries the local-harness policy version, because the
    // argv denylist, environment allowlist, and permission mapping govern an
    // isolated session as much as a native one. An isolated target ALSO
    // carries the isolation policy version, so a change to either invalidates
    // the grants that depend on it — the separation `targets.ts` documents.
    policyVersion:
      target.kind === "local-native"
        ? target.policyVersion
        : LOCAL_HARNESS_POLICY_VERSION,
    ...(target.kind === "local-isolated"
      ? { isolationPolicyVersion: target.isolationPolicyVersion }
      : {}),
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
