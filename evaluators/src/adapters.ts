import type { EvaluatorResult } from "./contract/evaluator-types.js";
/** Preserve unscored outcomes as null, never fabricate a failure or passing score. */
export function toFeedbackEvaluator(result: EvaluatorResult) {
  return {
    key: result.evaluatorId,
    score: result.status === "scored" ? result.score : null,
    comment: result.explanation,
    metadata: {
      status: result.status,
      definitionHash: result.definitionHash,
      evaluatorVersion: result.evaluatorVersion,
    },
  };
}
export function toNamedEvaluator(result: EvaluatorResult) {
  const feedback = toFeedbackEvaluator(result);
  return {
    name: feedback.key,
    score: feedback.score,
    metadata: { ...feedback.metadata, explanation: feedback.comment },
  };
}
