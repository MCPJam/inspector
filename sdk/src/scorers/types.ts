/**
 * The scorer interface.
 *
 * A scorer pairs a {@link ScoreDefinition} (what it is, whether it gates) with
 * a `score` function that returns a RAW observation. It never returns a
 * finished {@link ScoreResult}: only `finalizeScoreResult` in the contract can
 * mint one, which is the structural reason a scorer cannot assert its own
 * `passed` or slip a value outside [0,1] onto the wire.
 */

import type {
  ScoreDefinition,
  ScoreRawOutcome,
  ScorerContextV1,
} from "../contract/types.js";

/** Default hard cap on a single scorer's execution. */
export const DEFAULT_SCORER_TIMEOUT_MS = 60_000;

/** Default number of scorers allowed to run at once within one iteration. */
export const DEFAULT_SCORER_CONCURRENCY = 4;

export type Scorer = {
  definition: ScoreDefinition;
  /**
   * Grade one iteration.
   *
   * `signal` is a courtesy, not a guarantee — a custom scorer is free to ignore
   * it, which is exactly why the runner ALSO races against a hard timeout. Any
   * throw is caught by the runner and becomes an `error` result, never a low
   * score.
   */
  score(
    context: ScorerContextV1,
    signal?: AbortSignal
  ): ScoreRawOutcome | Promise<ScoreRawOutcome>;
  /**
   * Hard cap for this scorer, overriding {@link DEFAULT_SCORER_TIMEOUT_MS}.
   * A judge sets its own so a slow provider cannot hold an iteration open.
   */
  timeoutMs?: number;
};

/** Bounds the runner enforces regardless of what a scorer does. */
export type ScorerRunOptions = {
  /** Max scorers in flight at once. Default {@link DEFAULT_SCORER_CONCURRENCY}. */
  concurrency?: number;
  /** Fallback per-scorer timeout. Default {@link DEFAULT_SCORER_TIMEOUT_MS}. */
  timeoutMs?: number;
  /**
   * When set, non-deterministic scorers are not run at all and are reported as
   * `skipped` with this reason. Used by the retry-exhausted path: grading a
   * partial transcript with a stochastic judge produces a number that means
   * nothing, while a deterministic scorer still says something true about what
   * the iteration actually did.
   */
  skipNonDeterministicReason?: string;
};

export type { ScoreDefinition, ScoreRawOutcome, ScorerContextV1 };
