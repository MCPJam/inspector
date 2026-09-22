/**
 * The identity of one hosted predicate scorer — the ONE implementation.
 *
 * WHY THIS IS IN `shared/`. The server mints these ids when it builds a
 * hosted iteration's score definitions, and they are persisted verbatim in
 * `metadata.evaluationConfig.definitions[].scorerId`. The client now has to
 * mint the same id to join an authored check back to the score row it
 * produced. A second implementation would drift the first time either side
 * touched the digest inputs, and the failure would be silent: rows would stop
 * joining and every scorer would quietly read "not measured".
 *
 * So there is one function, here, and `server/services/evals/score-definitions`
 * imports and re-exports it.
 *
 * The id is derived from the predicate's CONTENT (plus its turn scope, which is
 * part of what is being asserted) rather than from its position, so it is
 * stable across an edit elsewhere in the list. Check POLICY is stripped first:
 * `role` and `severity` describe what a miss does, not what is being checked,
 * so flipping a check from Gate to Warn must keep joining its own history.
 */

import { canonicalDigest } from "@mcpjam/sdk/contract";
import {
  stripCheckPolicy,
  type Predicate,
  type PredicateScope,
} from "@mcpjam/sdk/predicates";

/** Stable id of the hosted tool-call matcher projection. */
export const HOSTED_TOOL_MATCH_SCORER_ID = "toolCalls:match";
/** Stable id of the hosted goal-completion judge projection. */
export const HOSTED_JUDGE_SCORER_ID = "judge:goalCompletion";

/**
 * The criterion identity of one hosted predicate.
 *
 * Pinned by a golden test: these strings are persisted on every hosted
 * iteration ever graded, so a change here is a change to historical data.
 */
export function hostedCriterionId(
  predicate: Predicate,
  scope?: PredicateScope,
): string {
  const criterion = stripCheckPolicy(predicate);
  const digest = canonicalDigest(
    scope ? { predicate: criterion, scope } : { predicate: criterion },
  ).slice(0, 12);
  return `${predicate.type}-${digest}`;
}

/** `predicate:<criterionId>` — the persisted `scorerId` of a predicate row. */
export function hostedPredicateScorerId(
  predicate: Predicate,
  scope?: PredicateScope,
): string {
  return `predicate:${hostedCriterionId(predicate, scope)}`;
}
