/**
 * The legacy names for the evaluator stage tables.
 *
 * The tables themselves moved to `evaluator-stage.ts` with the program's
 * canonical vocabulary (`docs/evals-vocabulary-consolidation.md`). This file
 * keeps the old names resolving — every consumer still imports them, and they
 * are exported from `@mcpjam/sdk/contract`, which is a published surface.
 *
 * ── Why the seed did NOT move with them ──────────────────────────────────────
 *
 * `RECOMMENDED_DEFAULT_PREDICATES` is pinned by the backend through a whole-file
 * `capture` in `convex/lib/mirrors.json`: a regex over the three
 * `{ type, role, severity }` triples, matched against THIS file. The checker
 * hashes what the capture matched, and a capture that matches nothing hashes to
 * a stable empty string — so moving the literal would not fail the pin. It
 * would make the pin pass forever, from the moment it stopped watching
 * anything, which is strictly worse than a loud failure.
 *
 * So the declaration stays here, byte for byte, and `evaluator-stage.ts`
 * re-exports it under the canonical name instead.
 */

import {
  ASSERTION_KINDS,
  ASSERTION_STAGE,
  EVALUATOR_PRESENTATION_GROUP,
  EVALUATOR_STAGE,
  isSelectionStageAssertionKind,
  type AssertionKind,
} from "./evaluator-stage.js";

/** @deprecated Use `ASSERTION_KINDS` from `./evaluator-stage.js`. */
export const PREDICATE_KINDS = ASSERTION_KINDS;
/** @deprecated Use `AssertionKind` from `./evaluator-stage.js`. */
export type PredicateKind = AssertionKind;
/** @deprecated Use `ASSERTION_STAGE` from `./evaluator-stage.js`. */
export const PREDICATE_STAGE = ASSERTION_STAGE;
/** @deprecated Use `EVALUATOR_STAGE` from `./evaluator-stage.js`. */
export const GRADER_STAGE = EVALUATOR_STAGE;
/** @deprecated Use `EVALUATOR_PRESENTATION_GROUP` from `./evaluator-stage.js`. */
export const GRADER_PRESENTATION_GROUP = EVALUATOR_PRESENTATION_GROUP;
/** @deprecated Use `isSelectionStageAssertionKind` from `./evaluator-stage.js`. */
export const isSelectionStagePredicateKind = isSelectionStageAssertionKind;

/**
 * The checks a NEW suite starts with when its creator says nothing about
 * checks at all.
 *
 * HAND-MIRRORED from `mcpjam-backend/convex/lib/predicates.ts`
 * (`RECOMMENDED_DEFAULT_PREDICATES`), which is where the seed is APPLIED. This
 * copy exists so the scorer library can mark these kinds "Recommended", and so
 * the acceptance-corpus test can prove — on this side, where the evaluator
 * lives — that nothing enters the set above the corpus bar.
 *
 * NOTHING HERE GATES. The predicate gate is independent of a case's
 * `failOnToolError`, so a seeded gating `noToolErrors` would flip a case that
 * sets it false, hits an error, recovers and passes today. Warn preserves
 * effective case policy: the row is visible, the verdict is untouched.
 *
 * `noDeprecatedToolCalled` is an observation and is here on EVIDENCE: it is the
 * one heuristic that clears the corpus bar (zero detector errors and zero
 * misleading firings). The other four observations do not, and a kind that
 * starts firing misleadingly on a newly added corpus item leaves this list.
 */
export const RECOMMENDED_DEFAULT_PREDICATES = [
  { type: "noToolErrors", role: "advisory", severity: "warn" },
  { type: "argumentsMatchToolSchema", role: "advisory", severity: "warn" },
  { type: "noDeprecatedToolCalled", role: "advisory", severity: "warn" },
] as const satisfies ReadonlyArray<{
  type: PredicateKind;
  role: "advisory";
  severity: "warn";
}>;

/** True when a new suite starts with this kind. Drives the "Recommended" chip. */
export function isRecommendedDefaultPredicateKind(kind: string): boolean {
  return RECOMMENDED_DEFAULT_PREDICATES.some(
    (predicate) => predicate.type === kind
  );
}
