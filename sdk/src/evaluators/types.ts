/**
 * The evaluator runtime's own shapes.
 *
 * An {@link Evaluator} is a {@link Scorer} that speaks the canonical
 * vocabulary: `evaluate` rather than `score`, and a raw outcome whose numeric
 * field is `score` rather than `value`. Both are accepted everywhere a list of
 * evaluators is taken, because a repository mid-migration has both and making
 * the author convert a list before passing it would be a rename tax with no
 * safety behind it.
 */

import type {
  EvaluatorContextV1,
  EvaluatorDefinition,
  EvaluatorRawOutcome,
} from "../contract/evaluator-types.js";
import type { Scorer, ScorerRunOptions } from "../scorers/types.js";
import {
  DEFAULT_SCORER_CONCURRENCY,
  DEFAULT_SCORER_TIMEOUT_MS,
} from "../scorers/types.js";

export type Evaluator = {
  definition: EvaluatorDefinition;
  /**
   * Observe this iteration. Never returns a verdict — bounds and `passed` are
   * derived in one place, so an implementation asserting its own pass would be
   * overruling the threshold its author configured.
   */
  evaluate(
    context: EvaluatorContextV1,
    signal?: AbortSignal
  ): EvaluatorRawOutcome | Promise<EvaluatorRawOutcome>;
  /** Per-evaluator hard timeout. Falls back to the runner's. */
  timeoutMs?: number;
};

/** An assertion: a deterministic authored rule, carried with its rule. */
export type AssertionEvaluator = Evaluator & {
  readonly kind: "assertion";
  readonly rule: import("../contract/evaluator-types.js").Assertion;
  readonly id?: string;
};

/** A judge: a model grading against a rubric. */
export type JudgeEvaluator = Evaluator & { readonly kind: "judge" };

/** Either vocabulary. Accepted wherever a list of evaluators is taken. */
export type AnyEvaluator = Evaluator | Scorer;

export type EvaluatorRunOptions = ScorerRunOptions;

/** Max evaluators in flight per iteration. */
export const DEFAULT_EVALUATOR_CONCURRENCY = DEFAULT_SCORER_CONCURRENCY;
/** Fallback per-evaluator hard timeout. */
export const DEFAULT_EVALUATOR_TIMEOUT_MS = DEFAULT_SCORER_TIMEOUT_MS;
