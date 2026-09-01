/**
 * Execution targets for a harness turn — the three honest choices the product
 * offers, and the identities each one is authorized against.
 *
 * The whole point of this module is that "where does this run, and what
 * authority does it have" is ONE explicit value threaded through create / turn
 * / resume / stop, never inferred from ambient config. A turn that cannot name
 * its target does not run.
 *
 * TRUST MODEL — read before editing:
 *  - `cloud` is the existing E2B path: a cloud sandbox is the containment
 *    boundary.
 *  - `local-native` runs an official vendor harness as a supervised host
 *    process. It is NOT a host containment boundary. Its authority is the OS
 *    user's, narrowed only by the vendor's own permission controls, the
 *    supervisor's process/resource ceilings, and the user's consent. Product
 *    copy, telemetry, and audit records must never call it sandboxed or
 *    isolated.
 *  - `local-isolated` is the same supervised process wrapped in a verified
 *    OS-native / OCI / VM backend. It is advertised ONLY where that backend
 *    has passed conformance, and it NEVER silently degrades to native.
 *
 * No raw host path is an authorization primitive here. A workspace is named by
 * an opaque `workspaceGrantId` that resolves to a canonical path only inside
 * the local trusted process (see `grants.ts`); a runtime is named by an opaque
 * `runtimeId` that resolves to a verified bundle or executable only inside
 * `runtime-identity.ts`.
 */

/** A harness this Inspector has a REVIEWED local compatibility manifest for.
 *  Deliberately narrower than the SDK's `Harness` union: shipping a local
 *  adapter is a security-sensitive act, so an id earns a place here only with
 *  a manifest entry (`compatibility.ts`) and conformance evidence. */
export type SupportedLocalHarnessId = "claude-code" | "codex";

export const SUPPORTED_LOCAL_HARNESS_IDS: readonly SupportedLocalHarnessId[] = [
  "claude-code",
  "codex",
];

/** Platforms local execution can be attempted on. Support is per
 *  harness/platform tuple (`compatibility.ts`), never blanket. */
export type LocalPlatform = "darwin" | "linux" | "win32";

/** Isolation backends. Presence in this union is a TYPE, not a promise —
 *  a backend is advertised only after `isolatedBackends` lists it for the
 *  harness AND its startup escape probes pass. */
export type LocalIsolationBackend =
  | "linux-bwrap"
  | "darwin-seatbelt"
  | "oci-v1"
  | "vm-v1";

/**
 * Inspector's permission intent for a turn, mapped per adapter onto the SDK's
 * `HarnessV1PermissionMode`.
 *
 * Kept as its OWN vocabulary rather than reusing the SDK's three modes,
 * because the SDK's `allow-all` is a default we must never inherit
 * accidentally (invariant 8): an Inspector profile is chosen deliberately, and
 * `unrestricted` is spelled out so that granting it is visible in every diff,
 * grant record, and audit line that carries it.
 */
export type LocalPermissionProfile =
  /** Reads only; every edit and command needs an approval round-trip. */
  | "read-only"
  /** Edits inside the granted workspace; commands still need approval. */
  | "workspace-edits"
  /** No approval gate at all. Legal ONLY inside a verified isolation backend
   *  (see `assertPermissionProfileAllowed`). */
  | "unrestricted";

export const LOCAL_PERMISSION_PROFILES: readonly LocalPermissionProfile[] = [
  "read-only",
  "workspace-edits",
  "unrestricted",
];

/**
 * Version of the local-execution POLICY (target rules, argv denylist, env
 * allowlist, permission mapping). Bumping it invalidates every consent grant
 * minted under the old rules — a user consented to the guarantees as they were
 * described, so changing the guarantees re-asks.
 */
export const LOCAL_HARNESS_POLICY_VERSION = "local-harness-policy-2026-09-01";

/**
 * Version of the ISOLATION policy (backend selection, mount/seccomp/Seatbelt
 * rules, egress restriction). Separate from the policy version above because
 * an isolation rule change must invalidate isolated grants without disturbing
 * native ones, and vice versa.
 */
export const LOCAL_ISOLATION_POLICY_VERSION =
  "local-isolation-policy-2026-09-01";

export type HarnessExecutionTarget =
  | {
      kind: "cloud";
      provider: "e2b";
    }
  | {
      kind: "local-native";
      machineId: string;
      workspaceGrantId: string;
      harnessId: SupportedLocalHarnessId;
      runtimeId: string;
      permissionProfile: LocalPermissionProfile;
      policyVersion: string;
    }
  | {
      kind: "local-isolated";
      machineId: string;
      workspaceGrantId: string;
      harnessId: SupportedLocalHarnessId;
      runtimeId: string;
      backend: LocalIsolationBackend;
      permissionProfile: LocalPermissionProfile;
      isolationPolicyVersion: string;
    };

export type LocalHarnessExecutionTarget = Extract<
  HarnessExecutionTarget,
  { kind: "local-native" | "local-isolated" }
>;

export function isLocalTarget(
  target: HarnessExecutionTarget
): target is LocalHarnessExecutionTarget {
  return target.kind === "local-native" || target.kind === "local-isolated";
}

/** The label a target may be shown under. Native is never "sandboxed" or
 *  "isolated" — invariant 6 is enforced here so no call site has to remember
 *  it, and a test locks the strings. */
export function executionTargetLabel(target: HarnessExecutionTarget): string {
  switch (target.kind) {
    case "cloud":
      return "Hosted";
    case "local-native":
      return "Native on this machine";
    case "local-isolated":
      return `Isolated on this machine (${target.backend})`;
  }
}

/**
 * Does this target carry an OUTER host containment boundary?
 *
 * The one question product copy, telemetry, and the audit log must agree on.
 * `local-native` answers false — always — no matter how narrow its permission
 * profile, how confined the Inspector file API is, or how tidy its synthetic
 * home. Those reduce accidents; none of them contains a process running as the
 * OS user.
 */
export function targetHasHostContainment(
  target: HarnessExecutionTarget
): boolean {
  return target.kind === "cloud" || target.kind === "local-isolated";
}

/** The current platform as a `LocalPlatform`, or null where local execution is
 *  not a supported concept at all. */
export function currentLocalPlatform(
  platform: NodeJS.Platform = process.platform
): LocalPlatform | null {
  if (platform === "darwin" || platform === "linux" || platform === "win32") {
    return platform;
  }
  return null;
}
