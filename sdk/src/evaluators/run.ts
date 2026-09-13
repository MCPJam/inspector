/**
 * Running evaluators is running scorers.
 *
 * This module adapts the canonical shape onto the existing one and delegates.
 * It deliberately does NOT reimplement the bounds: the per-evaluator timeout,
 * the concurrency cap, the rule that every failure lands as an `error` row
 * rather than a low score, and the retry-exhausted skip all live in
 * `scorers/run.ts` and stay there. A second bounded runner would be a second
 * place for "what happens when a judge hangs" to be answered, and the two
 * answers would drift in the direction nobody tests.
 */

import { toScoreRawOutcome } from "../contract/evaluator-derive.js";
import type {
  EvaluatorContextV1,
  EvaluatorResult,
  ResolvedEvaluatorDefinition,
} from "../contract/evaluator-types.js";
import { toEvaluatorResult } from "../contract/evaluator-derive.js";
import { runScorers, scoresPassed } from "../scorers/run.js";
import type { Scorer } from "../scorers/types.js";
import type { ScoreResult } from "../contract/types.js";
import type { AnyEvaluator, EvaluatorRunOptions } from "./types.js";

/** Is this the canonical shape, or the one that predates it? */
function isCanonical(
  evaluator: AnyEvaluator
): evaluator is import("./types.js").Evaluator {
  return typeof (evaluator as { evaluate?: unknown }).evaluate === "function";
}

/**
 * Present a canonical evaluator as the scorer the runner already knows.
 *
 * The outcome projection is applied lazily — inside `score`, after the
 * evaluator has run — so a synchronous evaluator stays synchronous and a
 * rejected promise still reaches the runner's catch, where it becomes an error
 * row instead of an unhandled rejection.
 */
function asScorer(evaluator: AnyEvaluator): Scorer {
  if (!isCanonical(evaluator)) return evaluator;
  return {
    definition: evaluator.definition,
    ...(evaluator.timeoutMs !== undefined
      ? { timeoutMs: evaluator.timeoutMs }
      : {}),
    score: (context, signal) => {
      const outcome = evaluator.evaluate(context, signal);
      // Thenable, not `instanceof Promise`. A promise built in another realm —
      // a Node `vm` context, an iframe — satisfies the declared return type and
      // fails a realm-specific check, and the raw promise would then be
      // projected as though it were the outcome itself.
      return isPromiseLike(outcome)
        ? Promise.resolve(outcome).then(toScoreRawOutcome)
        : toScoreRawOutcome(outcome);
    },
  };
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

/**
 * Grade an iteration with every evaluator, in authored order, under the
 * runner's bounds. Returns the stored shape; see {@link runEvaluatorsProjected}
 * for the canonical one.
 */
export function runEvaluators(
  evaluators: readonly AnyEvaluator[],
  context: EvaluatorContextV1,
  options?: EvaluatorRunOptions
): Promise<ScoreResult[]> {
  return runScorers(evaluators.map(asScorer), context, options);
}

/** The same run, projected into canonical results. */
export async function runEvaluatorsProjected(
  evaluators: readonly AnyEvaluator[],
  context: EvaluatorContextV1,
  options?: EvaluatorRunOptions
): Promise<EvaluatorResult[]> {
  const scores = await runEvaluators(evaluators, context, options);
  return scores.map(toEvaluatorResult);
}

/**
 * Whether a set of results clears the gate.
 *
 * The same single decision as `scoresPassed`, under the canonical name. Policy
 * is read off the DEFINITIONS, joined on `definitionHash` — a result with no
 * matching definition is treated as gating and failing, because an unjoinable
 * row is evidence something is wrong with the run and missing evidence must
 * never read as a pass.
 */
export function evaluatorsPassed(
  results: ScoreResult[],
  definitions: ResolvedEvaluatorDefinition[]
): boolean {
  return scoresPassed(results, definitions);
}
