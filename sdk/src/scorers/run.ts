/**
 * Bounded execution of a set of scorers against one iteration.
 *
 * Two bounds, both enforced by the RUNNER rather than trusted to the scorer:
 *
 *   - **A hard timeout per scorer.** `AbortSignal` is cooperative, and a custom
 *     scorer that ignores it would otherwise hold an iteration open forever. The
 *     `Promise.race` is the enforcement; the signal is the courtesy that lets a
 *     well-behaved scorer cancel its HTTP request too.
 *   - **A concurrency cap.** N judges × 30 iterations would otherwise stampede a
 *     provider into rate-limiting the whole run.
 *
 * Every failure mode lands as an `error` result, never as a low score, and the
 * gate engine decides what that means by reading the definition's `onError`.
 */

import {
  errorScoreResult,
  finalizeScoreResult,
  resolveScoreDefinition,
  skippedScoreResult,
} from "../contract/derive.js";
import { definitionHash } from "../contract/derive.js";
import type {
  ResolvedScoreDefinition,
  ScoreResult,
  ScorerContextV1,
} from "../contract/types.js";
import { Semaphore } from "./concurrency.js";
import {
  DEFAULT_SCORER_CONCURRENCY,
  DEFAULT_SCORER_TIMEOUT_MS,
  type Scorer,
  type ScorerRunOptions,
} from "./types.js";

class ScorerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`scorer timed out after ${timeoutMs}ms`);
    this.name = "ScorerTimeoutError";
  }
}

/**
 * Run one scorer under its bounds. Resolves to a finished row for every
 * outcome — it never rejects, so one misbehaving scorer cannot take down the
 * others or the iteration.
 */
async function runOne(
  scorer: Scorer,
  definition: ResolvedScoreDefinition,
  context: ScorerContextV1,
  timeoutMs: number
): Promise<ScoreResult> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new ScorerTimeoutError(timeoutMs);
        // Signal first so a cooperative scorer can abort its request, then
        // reject — the race resolves regardless of whether it cooperates.
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });

    const outcome = await Promise.race([
      Promise.resolve().then(() => scorer.score(context, controller.signal)),
      timeout,
    ]);
    return finalizeScoreResult(definition, outcome);
  } catch (error) {
    return errorScoreResult(definition, error);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Grade an iteration with every scorer, in authored order, under the runner's
 * bounds. Results come back in authored order regardless of completion order,
 * so a dashboard renders the same list every time.
 */
export async function runScorers(
  scorers: Scorer[],
  context: ScorerContextV1,
  options?: ScorerRunOptions
): Promise<ScoreResult[]> {
  if (scorers.length === 0) return [];

  const concurrency = Math.max(
    1,
    options?.concurrency ?? DEFAULT_SCORER_CONCURRENCY
  );
  const fallbackTimeout = options?.timeoutMs ?? DEFAULT_SCORER_TIMEOUT_MS;
  const semaphore = new Semaphore(concurrency);
  const skipReason = options?.skipNonDeterministicReason;

  return Promise.all(
    scorers.map(async (scorer) => {
      const definition = resolveScoreDefinition(scorer.definition);

      // The retry-exhausted path. A gating judge skipped here fails closed by
      // default, which is correct: an unscored gate is not a passed gate, and
      // the rationale says exactly why so nobody has to guess.
      if (skipReason && !definition.deterministic) {
        return skippedScoreResult(definition, skipReason);
      }

      await semaphore.acquire();
      try {
        return await runOne(
          scorer,
          definition,
          context,
          scorer.timeoutMs ?? fallbackTimeout
        );
      } finally {
        semaphore.release();
      }
    })
  );
}

/**
 * Whether a set of scores clears the gate.
 *
 * The one place `passed` is decided for an iteration, and it reads policy off
 * the DEFINITIONS rather than the rows — results deliberately do not repeat
 * `role`/`onError`/`onSkipped`, so there is no second copy to disagree with.
 *
 *   - advisory scores never gate, whatever their status;
 *   - `not_applicable` never gates (and never enters a denominator);
 *   - a gating `scored` row must have passed;
 *   - a gating `error` / `skipped` row fails unless its policy says ignore.
 *
 * The join is on `definitionHash`, not `scorerId`. Matching by id would let a
 * row produced under one configuration be graded against another — which is
 * precisely the substitution an integrity check exists to catch. A result with
 * no matching definition is treated as GATING and failing: an unjoinable row is
 * evidence something is wrong with the run, and the whole point of this
 * contract is that missing evidence never reads as a pass.
 */
export function scoresPassed(
  scores: ScoreResult[],
  definitions: ResolvedScoreDefinition[]
): boolean {
  const byHash = new Map(
    definitions.map((definition) => [definitionHash(definition), definition])
  );

  for (const score of scores) {
    const definition = byHash.get(score.definitionHash);
    if (!definition) return false;
    if (definition.role !== "gating") continue;

    switch (score.status) {
      case "scored":
        if (score.passed !== true) return false;
        break;
      case "error":
        if (definition.onError === "fail") return false;
        break;
      case "skipped":
        if (definition.onSkipped === "fail") return false;
        break;
      case "not_applicable":
        break;
      default: {
        // An unknown status is unhandled evidence, and unhandled evidence
        // fails closed.
        return false;
      }
    }
  }
  return true;
}
