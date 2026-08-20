/**
 * Finding constructors.
 *
 * Checks never build a {@link ClaudeReadinessFinding} literal. Going through
 * these is what guarantees the fields that make a grade auditable — source
 * citation, provenance, intrusiveness, engine version, timestamp — are present
 * on every finding rather than on the ones whose author remembered. A check
 * that could construct a finding by hand is a check that can quietly ship one
 * with no provenance.
 *
 * Pure data. No transport.
 */

import type { ClaudePolicySourceRef } from "../manifest.js";
import {
  CLAUDE_READINESS_ENGINE_VERSION,
  type ClaudeEvidenceProvenance,
  type ClaudeFindingClass,
  type ClaudeIntrusiveness,
  type ClaudeReadinessFinding,
  type ClaudeReadinessLane,
  type ClaudeRunnerCapability,
} from "../types.js";

/** Everything about a check that does not depend on what it observed. */
export interface ClaudeCheckDefinition {
  id: string;
  title: string;
  lane: ClaudeReadinessLane;
  class: ClaudeFindingClass;
  source: ClaudePolicySourceRef;
  provenance: ClaudeEvidenceProvenance;
  /** Defaults to `read-only`; a purely static lint should say `passive`. */
  intrusiveness?: ClaudeIntrusiveness;
  requiresCapabilities?: ClaudeRunnerCapability[];
}

/** What every check is handed, so none of them reads a clock of its own. */
export interface ClaudeCheckStamp {
  /** One timestamp for the whole run: findings from one run are one moment. */
  evaluatedAt: string;
}

function base(
  definition: ClaudeCheckDefinition,
  stamp: ClaudeCheckStamp,
): Omit<ClaudeReadinessFinding, "status"> {
  return {
    id: definition.id,
    title: definition.title,
    lane: definition.lane,
    class: definition.class,
    source: definition.source,
    provenance: definition.provenance,
    intrusiveness: definition.intrusiveness ?? "read-only",
    requiresCapabilities: definition.requiresCapabilities,
    evaluatedAt: stamp.evaluatedAt,
    engineVersion: CLAUDE_READINESS_ENGINE_VERSION,
  };
}

export function satisfied(
  definition: ClaudeCheckDefinition,
  stamp: ClaudeCheckStamp,
  details?: Record<string, unknown>,
): ClaudeReadinessFinding {
  return { ...base(definition, stamp), status: "satisfied", details };
}

export function violated(
  definition: ClaudeCheckDefinition,
  stamp: ClaudeCheckStamp,
  remediation: string,
  details?: Record<string, unknown>,
): ClaudeReadinessFinding {
  return { ...base(definition, stamp), status: "violated", remediation, details };
}

/**
 * The requirement applies here but this run never exercised it.
 *
 * `reason` is not optional, and that is the point: an unevaluated requirement
 * with no stated reason is indistinguishable from a bug, and it is what makes
 * the lane's `incomplete` status actionable rather than mysterious.
 */
export function notEvaluated(
  definition: ClaudeCheckDefinition,
  stamp: ClaudeCheckStamp,
  reason: string,
  details?: Record<string, unknown>,
): ClaudeReadinessFinding {
  return {
    ...base(definition, stamp),
    status: "not-evaluated",
    notEvaluatedReason: reason,
    details,
  };
}

/**
 * The requirement cannot apply to THIS target — an app-only rule against a
 * server with no apps, an OAuth rule against an authless server.
 *
 * Distinct from {@link notEvaluated} in exactly the way `not-applicable` is
 * distinct from `could-not-run` in the suites: nothing was left unverified.
 */
export function notApplicable(
  definition: ClaudeCheckDefinition,
  stamp: ClaudeCheckStamp,
  reason: string,
): ClaudeReadinessFinding {
  return {
    ...base(definition, stamp),
    status: "not-applicable",
    notEvaluatedReason: reason,
  };
}

/** A statement that carries no pass/fail meaning — badges, observations. */
export function informational(
  definition: ClaudeCheckDefinition,
  stamp: ClaudeCheckStamp,
  details?: Record<string, unknown>,
  note?: string,
): ClaudeReadinessFinding {
  return {
    ...base(definition, stamp),
    status: "informational",
    remediation: note,
    details,
  };
}

/**
 * Mark a finding as derived from an existing suite result rather than
 * re-observed.
 *
 * Readiness COMPOSES: re-running an equivalent check would let readiness and
 * the suite disagree about the same server, and the first question anyone asks
 * about a disagreement is which one to believe.
 */
export function derivedFrom(
  finding: ClaudeReadinessFinding,
  ...sources: string[]
): ClaudeReadinessFinding {
  return {
    ...finding,
    derivedFrom: [...(finding.derivedFrom ?? []), ...sources],
  };
}
