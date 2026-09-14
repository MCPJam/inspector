/**
 * Which spelling of the policy role this build EMITS.
 *
 * `"required"` and `"gating"` are one value with two spellings. Reading both
 * is unconditional and permanent — a stored contract is historical evidence
 * and is never rewritten. Writing the canonical one is a rollout step, and
 * this module is its single switch.
 *
 * Why a switch rather than just emitting it: a score contract carrying a role
 * the backend's `validateScorePayload` does not accept quarantines EVERY
 * iteration of the run as `score_integrity_invalid`. The dashboard then looks
 * empty rather than broken, which is the worst kind of failure to ship. So
 * emission waits for the boundary, and the boundary announces itself.
 */

import type { ScorerRole } from "./types.js";

/**
 * Flipped in ONE place, in the PR that switches emission on, after the backend
 * that accepts `"required"` is verified deployed to production.
 *
 * A build-time constant rather than an env var on purpose: a runner that could
 * be configured into emitting a spelling its backend refuses is a foot-gun
 * with no upside, and the runtime capability check below is the part that is
 * allowed to vary per deployment.
 */
export const EMIT_CANONICAL_ROLE = true;

/**
 * What a required role is WRITTEN as by this build.
 *
 * Build-time only. The per-deployment half is {@link roleForDeployment}, and
 * it is deliberately NOT folded in here: a definition builder has no
 * handshake, and threading a capability through every one of them would put
 * the check in a dozen places that could each forget it.
 */
export function authoredRequiredRole(): ScorerRole {
  return EMIT_CANONICAL_ROLE ? "required" : "gating";
}

/**
 * Does this deployment's advertised capability accept the canonical spelling?
 *
 * True iff `vocabulary.values.role` is present. The backend advertises that
 * key only from the deploy whose validators actually take `"required"`, so its
 * PRESENCE — not the presence of `vocabulary`, and not a version number — is
 * the signal. This is the pinned contract's rule: a client reads a capability
 * value, and never infers support from a field on an unrelated object.
 *
 * Absent or malformed reads as "no", which is the safe direction: emitting
 * legacy to a backend that would have taken canonical costs nothing.
 */
export function capabilityAcceptsCanonicalRole(capabilities: unknown): boolean {
  const values = (
    capabilities as { vocabulary?: { values?: { role?: unknown } } } | undefined
  )?.vocabulary?.values?.role;
  return Array.isArray(values);
}

/**
 * The spelling a role may be SENT as to one deployment.
 *
 * The runtime half, applied ONCE on the way out rather than at every builder.
 * The two repositories deploy independently and "merged" is not "deployed", so
 * a runner whose SDK emits `required` may still be talking to a backend whose
 * `validateScorePayload` refuses it — and that failure is the expensive one:
 * every iteration of the run is quarantined `score_integrity_invalid`, and the
 * dashboard then looks empty rather than broken.
 *
 * Hash-neutral by construction: `hashSpelling` freezes the payload's spelling,
 * so downgrading here changes no `definitionHash` and orphans no score row.
 */
export function roleForDeployment(
  role: ScorerRole,
  capabilities: unknown
): ScorerRole {
  if (role !== "required") return role;
  return capabilityAcceptsCanonicalRole(capabilities) ? "required" : "gating";
}

/** {@link roleForDeployment} over a definition list, uncopied when nothing moves. */
export function definitionsForDeployment<T extends { role: ScorerRole }>(
  definitions: readonly T[],
  capabilities: unknown
): readonly T[] {
  if (capabilityAcceptsCanonicalRole(capabilities)) return definitions;
  let changed = false;
  const out = definitions.map((definition) => {
    if (definition.role !== "required") return definition;
    changed = true;
    return { ...definition, role: "gating" as const };
  });
  return changed ? out : definitions;
}
