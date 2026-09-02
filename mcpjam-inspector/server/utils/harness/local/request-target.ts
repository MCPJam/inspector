/**
 * Reading the local execution target off a chat request.
 *
 * ── Why this is shared rather than written twice ─────────────────────────
 * Two routes reach `runHarnessTurn`: `/api/mcp/chat-v2` (the desktop app and
 * npx) and `/api/web/chat-v2` (hosted and the org-aware path). The local target
 * is only ever meaningful on the first — a hosted replica running a harness on
 * ITS machine is the structural thing this whole design forbids — but both have
 * to agree on the SHAPE, because a target parsed one way in one route and
 * another way in the other is how a gate gets skipped.
 *
 * So there is one parser, and the eligibility rules are stated in it rather
 * than repeated at each call site.
 *
 * ── What travels where, and why ──────────────────────────────────────────
 * The ids travel in the BODY, because they are opaque and non-secret and the
 * transcript may legitimately record which target a turn ran on. The consent
 * capability travels in a HEADER, because it is a secret and a body field would
 * enter persisted transcripts — the same split the local-computer consent uses.
 */
import { LOCAL_HARNESS_GRANT_HEADER } from "./grants.js";
import type { LocalHarnessExecutionTarget } from "./local-turn.js";

export { LOCAL_HARNESS_GRANT_HEADER };

/** The body field, before anything has been checked. */
export interface RawHarnessTargetInput {
  kind?: unknown;
  workspaceGrantId?: unknown;
  runtimeId?: unknown;
  machineId?: unknown;
  permissionProfile?: unknown;
  policyVersion?: unknown;
}

export type HarnessTargetParse =
  | { kind: "hosted" }
  | { kind: "local-native"; target: LocalHarnessExecutionTarget }
  | { kind: "refused"; reason: string };

const PERMISSION_PROFILES = new Set([
  "read-only",
  "workspace-edits",
  "unrestricted",
]);

/**
 * Parse and gate the target for one request.
 *
 * `hosted` is the answer to every ambiguity: an absent field, a malformed one,
 * an ineligible actor, or a server with the kill switch off. `refused` is used
 * ONLY when the caller explicitly asked for local and cannot have it, because
 * that is the case where silently running somewhere else would be the
 * dishonesty this design exists to remove — the caller is told, and decides.
 */
export function parseHarnessExecutionTarget(args: {
  body: { harnessTarget?: RawHarnessTargetInput } | null | undefined;
  grantTokenHeader: string | undefined;
  /**
   * The acting user, as the ROUTE resolved it from the verified bearer.
   *
   * Never from the request body. Consent binds to a user, so a user the caller
   * names is a user the caller chose — and the grant would then verify against
   * whatever identity the request asserted rather than the one that
   * authenticated.
   */
  actingUserId: string | null;
  /** `LOCAL_HARNESS_ENABLED && !HOSTED_MODE`, resolved by the route. */
  serverEnabled: boolean;
  /** False for a guest, a shared scenario session, or a journey/swarm run. */
  actorEligible: boolean;
}): HarnessTargetParse {
  const raw = args.body?.harnessTarget;
  if (raw === undefined || raw === null) return { kind: "hosted" };
  if (raw.kind !== "local-native") return { kind: "hosted" };

  if (!args.serverEnabled) {
    return {
      kind: "refused",
      reason:
        "Running Claude Code on this machine is disabled on this server " +
        "(MCPJAM_LOCAL_HARNESS_ENABLED).",
    };
  }
  if (!args.actorEligible) {
    return {
      kind: "refused",
      reason:
        "Running on this machine requires an attended, signed-in member " +
        "running their own turn. Guests, shared scenario sessions and " +
        "swarm-scoped runs run hosted.",
    };
  }

  const workspaceGrantId = asId(raw.workspaceGrantId);
  const runtimeId = asId(raw.runtimeId);
  const machineId = asId(raw.machineId);
  const policyVersion = asId(raw.policyVersion);
  const permissionProfile =
    typeof raw.permissionProfile === "string" &&
    PERMISSION_PROFILES.has(raw.permissionProfile)
      ? (raw.permissionProfile as LocalHarnessExecutionTarget["permissionProfile"])
      : null;
  if (
    workspaceGrantId === null ||
    runtimeId === null ||
    machineId === null ||
    policyVersion === null ||
    permissionProfile === null
  ) {
    return {
      kind: "refused",
      reason:
        "This local execution target is incomplete. Re-authorize local " +
        "execution on this machine.",
    };
  }

  if (args.actingUserId === null || args.actingUserId.length === 0) {
    return {
      kind: "refused",
      reason:
        "Running on this machine requires a signed-in member; this request " +
        "carries no resolved user.",
    };
  }

  const grantToken = (args.grantTokenHeader ?? "").trim();
  if (grantToken.length === 0) {
    // The ids alone are not consent. Refused rather than degraded, so a client
    // whose stored capability was dropped learns that instead of quietly
    // getting a hosted turn it did not ask for.
    return {
      kind: "refused",
      reason:
        "No local execution authorization was presented for this turn. " +
        "Authorize local execution on this machine and try again.",
    };
  }

  return {
    kind: "local-native",
    target: {
      kind: "local-native",
      workspaceGrantId,
      runtimeId,
      machineId,
      permissionProfile,
      policyVersion,
      grantToken,
      actingUserId: args.actingUserId,
    },
  };
}

/**
 * An opaque id, as a string.
 *
 * Bounded and character-restricted: these are ids this server minted, so
 * anything that is not shaped like one is not one — and they end up in a
 * grant-binding hash, where an unbounded value would be an unbounded hash
 * input.
 */
function asId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return null;
  if (!/^[A-Za-z0-9_.:@+-]+$/.test(trimmed)) return null;
  return trimmed;
}
