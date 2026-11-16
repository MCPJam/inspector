/**
 * Harness MCP receipt: which MCP route a harness turn ran on, and why.
 *
 * The Inspector's harness turn runner writes one per persisted turn trace
 * (`turnTrace.harnessMcpAtTurn`). The backend stores it after checking a
 * hand-mirrored copy of these rules (`convex/lib/harnessMcpAtTurn.ts`); the
 * shared parity fixture keeps the two readers in agreement.
 *
 * Rules both readers hold to:
 *
 *  - A receipt that breaks any rule is dropped whole. Nothing is repaired or
 *    truncated, so a stored receipt is always one a writer actually sent.
 *  - Only known keys are copied; an unexpected field never reaches storage.
 *  - `undefined` means absent. `null` in an optional field breaks the receipt.
 *  - `gaps` and `reasons` keep the writer's order and duplicates.
 *  - `profile` names whose handshake MCPJam's client performed. A writer sets
 *    it only when the connection it built proves it, and `profileDigest` only
 *    alongside `profile: "client"`.
 *  - No credentials and no ids.
 *
 * Pure and browser-safe.
 */

export const HARNESS_MCP_AT_TURN_VERSION = 1;
export const HARNESS_MCP_AT_TURN_UPSTREAMS = ["mcpjam", "harness"] as const;
export const HARNESS_MCP_AT_TURN_DELIVERIES = [
  "host-tools",
  "mcp-endpoint",
] as const;
export const HARNESS_MCP_AT_TURN_PROFILES = ["client", "generic"] as const;
export const HARNESS_MCP_AT_TURN_FORWARDING_KINDS = [
  "pass-through",
  "profiled",
] as const;
export const HARNESS_MCP_AT_TURN_QUALIFICATION_STATUSES = [
  "supported",
  "unsupported",
  "unknown",
  "not-required",
] as const;
export const HARNESS_MCP_AT_TURN_LIMITS = {
  string: 128,
  evidence: 512,
  gaps: 32,
  reasons: 32,
} as const;

export type HarnessMcpAtTurnUpstream =
  (typeof HARNESS_MCP_AT_TURN_UPSTREAMS)[number];
export type HarnessMcpAtTurnDelivery =
  (typeof HARNESS_MCP_AT_TURN_DELIVERIES)[number];
export type HarnessMcpAtTurnProfile =
  (typeof HARNESS_MCP_AT_TURN_PROFILES)[number];
export type HarnessMcpAtTurnForwardingKind =
  (typeof HARNESS_MCP_AT_TURN_FORWARDING_KINDS)[number];
export type HarnessMcpAtTurnQualificationStatus =
  (typeof HARNESS_MCP_AT_TURN_QUALIFICATION_STATUSES)[number];

export type HarnessMcpAtTurn = {
  version: typeof HARNESS_MCP_AT_TURN_VERSION;
  /** Who talked to the user's server. */
  upstream: HarnessMcpAtTurnUpstream;
  /** How the harness obtained the tools. */
  delivery: HarnessMcpAtTurnDelivery;
  profile?: HarnessMcpAtTurnProfile;
  forwarding?: { kind: HarnessMcpAtTurnForwardingKind };
  /** Why forwarding was bridged or refused, from the admission check. */
  gaps: string[];
  /** Why the planner chose this route. */
  reasons: string[];
  /** `""` when the runtime declares no pin. */
  pinnedRuntimeVersion: string;
  observedRuntimeVersion?: string;
  adapterVersion?: string;
  plannerVersion: string;
  qualification?: {
    status: HarnessMcpAtTurnQualificationStatus;
    evidence?: string;
  };
  /** Digest of the hostConfig connection profiles the handshake used. */
  profileDigest?: string;
};

const DIGEST = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(
  values: readonly T[],
  value: unknown
): value is T {
  return (
    typeof value === "string" && (values as readonly string[]).includes(value)
  );
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function entries(value: unknown, maxEntries: number): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxEntries) return undefined;
  const limit = HARNESS_MCP_AT_TURN_LIMITS.string;
  return value.every(
    (entry) =>
      typeof entry === "string" && entry.length > 0 && entry.length <= limit
  )
    ? [...value]
    : undefined;
}

/** An optional string: absent, or a string within `max` characters. */
function optionalString(
  value: unknown,
  max: number
): { ok: boolean; value?: string } {
  if (value === undefined) return { ok: true };
  return boundedString(value, max) ? { ok: true, value } : { ok: false };
}

/** The receipt as stored, or `undefined` when any rule is broken. */
export function parseHarnessMcpAtTurn(
  value: unknown
): HarnessMcpAtTurn | undefined {
  if (!isRecord(value) || value.version !== HARNESS_MCP_AT_TURN_VERSION) {
    return undefined;
  }
  const { upstream, delivery, profile, forwarding, qualification } = value;
  if (!oneOf(HARNESS_MCP_AT_TURN_UPSTREAMS, upstream)) return undefined;
  if (!oneOf(HARNESS_MCP_AT_TURN_DELIVERIES, delivery)) return undefined;
  if (profile !== undefined && !oneOf(HARNESS_MCP_AT_TURN_PROFILES, profile)) {
    return undefined;
  }
  let kind: HarnessMcpAtTurnForwardingKind | undefined;
  if (forwarding !== undefined) {
    if (!isRecord(forwarding)) return undefined;
    if (!oneOf(HARNESS_MCP_AT_TURN_FORWARDING_KINDS, forwarding.kind)) {
      return undefined;
    }
    kind = forwarding.kind;
  }
  // The harness's own client did the handshake: no profile of MCPJam's applies.
  if (upstream === "harness") {
    if (delivery !== "mcp-endpoint" || kind !== "pass-through")
      return undefined;
    if (profile !== undefined || value.profileDigest !== undefined) {
      return undefined;
    }
  }
  if (kind === "pass-through" && upstream !== "harness") return undefined;
  if (
    kind === "profiled" &&
    (delivery !== "mcp-endpoint" ||
      (profile !== undefined && profile !== "client"))
  ) {
    return undefined;
  }
  const limits = HARNESS_MCP_AT_TURN_LIMITS;
  const gaps = entries(value.gaps, limits.gaps);
  const reasons = entries(value.reasons, limits.reasons);
  if (!gaps || !reasons) return undefined;
  if (!boundedString(value.pinnedRuntimeVersion, limits.string))
    return undefined;
  if (!boundedString(value.plannerVersion, limits.string)) return undefined;
  const observed = optionalString(value.observedRuntimeVersion, limits.string);
  const adapter = optionalString(value.adapterVersion, limits.string);
  if (!observed.ok || !adapter.ok) return undefined;
  let status: HarnessMcpAtTurnQualificationStatus | undefined;
  let evidence: { ok: boolean; value?: string } = { ok: true };
  if (qualification !== undefined) {
    if (!isRecord(qualification)) return undefined;
    if (
      !oneOf(HARNESS_MCP_AT_TURN_QUALIFICATION_STATUSES, qualification.status)
    ) {
      return undefined;
    }
    status = qualification.status;
    evidence = optionalString(qualification.evidence, limits.evidence);
    if (!evidence.ok) return undefined;
  }
  const digest = value.profileDigest;
  if (
    digest !== undefined &&
    (profile !== "client" || typeof digest !== "string" || !DIGEST.test(digest))
  ) {
    return undefined;
  }
  return {
    version: HARNESS_MCP_AT_TURN_VERSION,
    upstream,
    delivery,
    ...(profile !== undefined ? { profile } : {}),
    ...(kind !== undefined ? { forwarding: { kind } } : {}),
    gaps,
    reasons,
    pinnedRuntimeVersion: value.pinnedRuntimeVersion,
    ...(observed.value !== undefined
      ? { observedRuntimeVersion: observed.value }
      : {}),
    ...(adapter.value !== undefined ? { adapterVersion: adapter.value } : {}),
    plannerVersion: value.plannerVersion,
    ...(status !== undefined
      ? {
          qualification: {
            status,
            ...(evidence.value !== undefined
              ? { evidence: evidence.value }
              : {}),
          },
        }
      : {}),
    ...(typeof digest === "string" ? { profileDigest: digest } : {}),
  };
}
