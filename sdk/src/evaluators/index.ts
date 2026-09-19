/**
 * The evaluator runtime: one authoring surface for assertions and judges.
 *
 * Every constructor here builds its definition through the function the legacy
 * constructor already used, so `assertion(rule)` and `predicateScorer(rule)`
 * are the same evaluator — same opaque id, same `implementationHash`, same
 * `definitionHash`. That equality is what lets an author migrate one rule at a
 * time without the run they compare against becoming a different run.
 */

export {
  DEFAULT_EVALUATOR_CONCURRENCY,
  DEFAULT_EVALUATOR_TIMEOUT_MS,
  type AnyEvaluator,
  type AssertionEvaluator,
  type Evaluator,
  type EvaluatorRunOptions,
  type JudgeEvaluator,
} from "./types.js";
export {
  runEvaluators,
  runEvaluatorsProjected,
  evaluatorsPassed,
} from "./run.js";
export { assertion } from "./assertion.js";
export { judge, type JudgeOptions } from "./judge.js";
export { toEvaluatorRawOutcome } from "./outcome.js";
