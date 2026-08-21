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
 * The constructors themselves are the shared `directory-readiness` factory,
 * bound ONCE here to Anthropic's engine version and its three type parameters.
 * Binding at module scope rather than per call is what keeps the version out
 * of a check author's hands: there is no argument to get wrong.
 *
 * Pure data. No transport.
 */

import { createFindingConstructors } from "../../directory-readiness/helpers.js";
import type {
  DirectoryCheckDefinition,
  DirectoryCheckStamp,
} from "../../directory-readiness/helpers.js";
import type { ClaudePolicySourceRef } from "../manifest.js";
import {
  CLAUDE_READINESS_ENGINE_VERSION,
  type ClaudeReadinessLane,
  type ClaudeRunnerCapability,
} from "../types.js";

/** Everything about a check that does not depend on what it observed. */
export type ClaudeCheckDefinition = DirectoryCheckDefinition<
  ClaudeReadinessLane,
  ClaudePolicySourceRef,
  ClaudeRunnerCapability
>;

/** What every check is handed, so none of them reads a clock of its own. */
export type ClaudeCheckStamp = DirectoryCheckStamp;

const constructors = createFindingConstructors<
  ClaudeReadinessLane,
  ClaudePolicySourceRef,
  ClaudeRunnerCapability
>({ engineVersion: CLAUDE_READINESS_ENGINE_VERSION });

export const satisfied = constructors.satisfied;

export const violated = constructors.violated;

/**
 * The requirement applies here but this run never exercised it.
 *
 * `reason` is not optional, and that is the point: an unevaluated requirement
 * with no stated reason is indistinguishable from a bug, and it is what makes
 * the lane's `incomplete` status actionable rather than mysterious.
 */
export const notEvaluated = constructors.notEvaluated;

/**
 * The requirement cannot apply to THIS target — an app-only rule against a
 * server with no apps, an OAuth rule against an authless server.
 *
 * Distinct from {@link notEvaluated} in exactly the way `not-applicable` is
 * distinct from `could-not-run` in the suites: nothing was left unverified.
 */
export const notApplicable = constructors.notApplicable;

/** A statement that carries no pass/fail meaning — badges, observations. */
export const informational = constructors.informational;

/**
 * Mark a finding as derived from an existing suite result rather than
 * re-observed.
 *
 * Readiness COMPOSES: re-running an equivalent check would let readiness and
 * the suite disagree about the same server, and the first question anyone asks
 * about a disagreement is which one to believe.
 */
export { derivedFrom } from "../../directory-readiness/helpers.js";
