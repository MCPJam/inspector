/**
 * The deterministic predicate scorer.
 *
 * Wraps one authored {@link Predicate} so it reports through the same contract
 * as everything else. It is a projection, not a re-implementation: the verdict
 * still comes from `evaluatePredicates`, so a predicate scored through this
 * path and a predicate evaluated the old way cannot disagree.
 */

import { evaluatePredicates } from "../predicates/evaluate.js";
import {
  requiresRenderObservations,
  type Predicate,
} from "../predicates/types.js";
import { predicateScoreDefinition } from "../contract/adapters.js";
import { canonicalDigest } from "../contract/canonical.js";
import type { ScorerRole } from "../contract/types.js";
import type { Scorer } from "./types.js";

/**
 * Reject a predicate a local run can never satisfy.
 *
 * The widget predicates read `renderObservations`, which only the hosted
 * headless-browser runner produces, and they fail CLOSED — so accepting one
 * here would mean every iteration fails with "no render observations" and the
 * author cannot tell a real regression from an unsupported check. Failing at
 * construction says exactly what is wrong, once. Mirrors the same guard in
 * `EvalTest`'s constructor.
 */
function assertLocallyEvaluable(predicate: Predicate): void {
  if (!requiresRenderObservations(predicate.type)) return;
  throw new Error(
    `Predicate ${predicate.type} needs widget render observations, which only ` +
      `a hosted run captures. Remove it from this code-first scorer, or move ` +
      `the case to a hosted eval suite.`
  );
}

export type PredicateScorerOptions = {
  /**
   * Stable id. Omit and a positional `predicate:<type>#<ordinal>` id is minted
   * — fine for local reporting, but UNSTABLE across config edits, so anything
   * gated in CI should name itself.
   */
  id?: string;
  /**
   * Position in the authored list; feeds the generated id.
   *
   * Omit it and the id is derived from the predicate's CONTENT instead of its
   * position, so two anonymous scorers of the same type cannot both mint
   * `predicate:<type>#0` and collide in the snapshot. Either way the id is
   * `idSource: "generated"` and therefore not gateable.
   */
  ordinal?: number;
  /** Predicates gate by default — determinism is what a release gate needs. */
  role?: ScorerRole;
};

export function predicateScorer(
  predicate: Predicate,
  options?: PredicateScorerOptions
): Scorer {
  assertLocallyEvaluable(predicate);
  const definition = predicateScoreDefinition(predicate, {
    id: options?.id,
    ordinal: options?.ordinal ?? 0,
    role: options?.role,
  });

  // Positional numbering is meaningless for a standalone scorer nobody gave an
  // index to, and defaulting every one of them to `#0` means two anonymous
  // scorers of the same predicate type mint the SAME id and collide in the
  // snapshot. When no ordinal was supplied, derive the suffix from the
  // predicate's content instead. Still `idSource: "generated"` — content-stable
  // is not the same as author-stable, and a gate must not select it.
  //
  // The WHOLE digest, not a prefix: two distinct predicates sharing a truncated
  // one would mint a single id for two different definitions, and the snapshot
  // builder would reject the config outright. `predicate:` + the longest
  // predicate type + 64 hex is comfortably inside MAX_SCORER_ID_LENGTH, so
  // there is nothing to buy by shortening it. Two IDENTICAL predicates still
  // land on one id — they are one definition, and the builder collapses them.
  if (options?.id === undefined && options?.ordinal === undefined) {
    definition.scorerId = `predicate:${predicate.type}#${canonicalDigest(
      predicate
    )}`;
  }

  return {
    definition,
    score(context) {
      // `context.transcript` is exactly the predicate-minimal shape the
      // evaluator already consumes — no adaptation, no second opinion.
      const [result] = evaluatePredicates(context.transcript, [predicate]);
      if (!result) {
        return {
          kind: "skipped",
          rationale: "predicate evaluator returned no verdict",
        };
      }
      return {
        kind: "scored",
        value: result.passed ? 1 : 0,
        rationale: result.reason,
        ...(result.scope ? { scope: result.scope } : {}),
      };
    },
  };
}
