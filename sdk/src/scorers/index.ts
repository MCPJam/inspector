/**
 * The scorer runtime.
 *
 * Lives in the SDK main entry (not `@mcpjam/sdk/contract`) because a judge
 * needs the model factory, which is not browser-safe. The contract itself —
 * shapes, hashing, derivation — stays pure and importable everywhere.
 */

export {
  DEFAULT_SCORER_CONCURRENCY,
  DEFAULT_SCORER_TIMEOUT_MS,
  type Scorer,
  type ScorerRunOptions,
} from "./types.js";
export { Semaphore } from "./concurrency.js";
export { runScorers, scoresPassed } from "./run.js";
export {
  predicateScorer,
  type PredicateScorerOptions,
} from "./predicate-scorer.js";
export {
  DEFAULT_JUDGE_THRESHOLD,
  JUDGE_TEMPLATE_VERSION,
  judgeScorer,
  type JudgeScorerOptions,
} from "./judge-scorer.js";
