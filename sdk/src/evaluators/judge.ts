/**
 * The judge constructor.
 *
 * A thin re-shaping of `judgeScorer` — same options, same validation, same
 * `implementationHash` over `{templateVersion, instruction, model}`. Sharing
 * the implementation is the point: a judge built either way must hash
 * identically, or migrating one case would read as a changed evaluation
 * configuration on every run that follows.
 */

import { judgeScorer, type JudgeScorerOptions } from "../scorers/judge-scorer.js";
import { toEvaluatorRawOutcome } from "./outcome.js";
import type { JudgeEvaluator } from "./types.js";

/** Exactly `JudgeScorerOptions`, under the canonical name. */
export type JudgeOptions = JudgeScorerOptions;

export function judge(options: JudgeOptions): JudgeEvaluator {
  const scorer = judgeScorer(options);
  return {
    kind: "judge",
    definition: scorer.definition,
    ...(scorer.timeoutMs !== undefined ? { timeoutMs: scorer.timeoutMs } : {}),
    evaluate(context, signal) {
      const outcome = scorer.score(context, signal);
      return outcome instanceof Promise
        ? outcome.then(toEvaluatorRawOutcome)
        : toEvaluatorRawOutcome(outcome);
    },
  };
}
