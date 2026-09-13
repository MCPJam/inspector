/**
 * The outcome projection in the direction `evaluator-derive.ts` does not need.
 *
 * That module projects a canonical outcome onto the stored one, which is the
 * direction the runner travels. This is the inverse, used when an evaluator
 * WRAPS a scorer rather than replacing it — `judge()` over `judgeScorer`, and
 * any adapter a consumer writes for an existing custom scorer.
 */

import type { EvaluatorRawOutcome } from "../contract/evaluator-types.js";
import type { ScoreRawOutcome } from "../contract/types.js";

export function toEvaluatorRawOutcome(
  outcome: ScoreRawOutcome
): EvaluatorRawOutcome {
  if (outcome.kind === "scored") {
    return {
      kind: "scored",
      score: outcome.value,
      ...(outcome.rationale !== undefined
        ? { explanation: outcome.rationale }
        : {}),
      ...(outcome.evidence !== undefined ? { evidence: outcome.evidence } : {}),
      ...(outcome.model !== undefined ? { model: outcome.model } : {}),
      ...(outcome.promptHash !== undefined
        ? { promptHash: outcome.promptHash }
        : {}),
      ...(outcome.scope !== undefined ? { scope: outcome.scope } : {}),
    };
  }
  return {
    kind: outcome.kind,
    ...(outcome.rationale !== undefined
      ? { explanation: outcome.rationale }
      : {}),
    ...(outcome.scope !== undefined ? { scope: outcome.scope } : {}),
  };
}
