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
export const EMIT_CANONICAL_ROLE = false;

/**
 * What a required role should be WRITTEN as by this build.
 *
 * `capabilityAcceptsCanonicalRole` is the per-deployment half: even with the
 * constant on, a runner talking to an older backend must fall back, because
 * the two repositories deploy independently and "merged" is not "deployed".
 * This is the pinned contract's rule — a client reads a capability VALUE, it
 * never infers support from the presence of a field on an unrelated object.
 */
export function authoredRequiredRole(
  capabilityAcceptsCanonical?: boolean,
): ScorerRole {
  return EMIT_CANONICAL_ROLE && capabilityAcceptsCanonical === true
    ? "required"
    : "gating";
}

/**
 * Does this deployment's advertised capability accept the canonical spelling?
 *
 * True iff `vocabulary.values.role` is present. The backend advertises that
 * key only from the deploy whose validators actually take `"required"`, so its
 * presence — not the presence of `vocabulary`, and not a version number — is
 * the signal. Absent or malformed is read as "no", fail-safe.
 */
export function capabilityAcceptsCanonicalRole(
  capabilities: unknown,
): boolean {
  const values = (
    capabilities as
      | { vocabulary?: { values?: { role?: unknown } } }
      | undefined
  )?.vocabulary?.values?.role;
  return Array.isArray(values);
}
