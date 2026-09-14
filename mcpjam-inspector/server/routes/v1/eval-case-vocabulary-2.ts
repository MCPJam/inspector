/**
 * The VOCABULARY-2 half of the eval case wire, kept beside `evals.ts` rather
 * than inside it.
 *
 * Under `x-mcpjam-eval-vocabulary: 2` the legacy per-case floor — the field
 * vocabulary 1 calls `iterations`, stored as Convex `runs` and read by the
 * legacy resolver as `max(runs, minimumIterations)` — answers to
 * `legacyIterations` (legacy spelling `runs`). Vocabulary 1 keeps `iterations`
 * for that field forever: it is byte-for-byte today's contract and is not
 * widened. So `evals.ts` genuinely holds both vocabularies of one wire, and
 * this module is where the vocabulary-2 spellings live.
 *
 * Why a separate file and not a section of `evals.ts`: the vocabulary codemod
 * (`scripts/codemod/evals-vocabulary`) guards per FILE that a rename's target
 * name is not already in use beside the name it replaces, and `evals.ts` is
 * one of the files it guards for `iterations → legacyIterations`. That guard
 * is correct — two fields must not become one — and it cannot tell an
 * expand-phase alias from a merge. Housing the new spelling here keeps the
 * guard meaningful for the file it watches, and keeps every vocabulary-2
 * spelling in one place a reader can diff against the contract.
 *
 * Everything here folds onto TODAY's internal body shape before storage.
 * `buildCaseMutationArgs` stays the single owner of "what reaches Convex"; a
 * vocabulary-2 body never forwards a canonical key to the platform.
 */

import type { z } from "zod";
import {
  CASE_FIELD_ALIASES_V2,
  addBothSpellingsIssues,
  type EvalVocabulary,
} from "./eval-vocabulary.js";

/**
 * Canonical → legacy pairs a vocabulary-2 case body refuses together.
 *
 * Derived from the alias table the capability block advertises, so a spelling
 * this refusal knows is a spelling `GET /capabilities` lists, and vice versa.
 * `iterations` and `legacyIterations` are never a pair: they are two
 * different fields (an exact count and a floor), not two spellings of one.
 */
export const CASE_SPELLING_PAIRS_V2: ReadonlyArray<readonly [string, string]> =
  (["legacyIterations"] as const).flatMap((canonical) =>
    CASE_FIELD_ALIASES_V2[canonical].map(
      (legacy) => [canonical, legacy] as const,
    ),
  );

/** The name the legacy per-case floor answers to under each vocabulary. */
export function floorFieldName(vocabulary: EvalVocabulary): string {
  return vocabulary === 2 ? "legacyIterations" : "iterations";
}

/**
 * The vocabulary-2 case body shape, built from vocabulary 1's.
 *
 * Same fields with one substitution: the floor moves from `iterations` to
 * `legacyIterations`, and its legacy spelling `runs` is accepted beside it.
 * Nothing else is re-declared, so a field added to the vocabulary-1 shape is
 * in vocabulary 2 too.
 */
export function caseBodyShapeV2<Shape extends { iterations: z.ZodTypeAny }>(
  v1: Shape,
): Omit<Shape, "iterations"> & {
  legacyIterations: Shape["iterations"];
  runs: Shape["iterations"];
} {
  const { iterations: floor, ...rest } = v1;
  return {
    ...rest,
    /**
     * The legacy per-case count, read by the legacy resolver as a FLOOR
     * (`max(legacyIterations, suite.minimumIterations)`). Stored as `runs`.
     */
    legacyIterations: floor,
    /** Legacy spelling of `legacyIterations`. */
    runs: floor,
  };
}

/** The both-spellings refinement for any vocabulary-2 case schema. */
export function refineCaseBodyV2(
  body: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  addBothSpellingsIssues(body, ctx, CASE_SPELLING_PAIRS_V2);
}

/**
 * Fold a validated vocabulary-2 case body onto vocabulary 1's shape.
 *
 * PRESENCE-based (`!== undefined`), never `??`: the refinement above has
 * already refused a body carrying both spellings, so the first present value
 * is the only one — and a `null` a later field may carry must reach storage as
 * the clear it is. A body that names neither spelling of the floor forwards
 * nothing for it, which is what lets a PATCH leave the stored `runs` exactly
 * as it was.
 */
export function foldCaseBodyV2ToV1<
  Body extends { legacyIterations?: number; runs?: number },
>(
  body: Body,
): Omit<Body, "legacyIterations" | "runs"> & { iterations?: number } {
  const { legacyIterations, runs, ...rest } = body;
  const floor = legacyIterations !== undefined ? legacyIterations : runs;
  return { ...rest, ...(floor !== undefined ? { iterations: floor } : {}) };
}

/**
 * Project a vocabulary-1 case DTO into the vocabulary the caller asked for.
 *
 * Under 1 the DTO is returned as is — the same object, not a copy, so nothing
 * about today's response can drift by accident. Under 2 the floor is renamed
 * in place: same position in the object, so the JSON a reader diffs against a
 * vocabulary-1 response differs in exactly the renamed key.
 */
export function projectCaseDto<Dto extends { iterations: number }>(
  dto: Dto,
  vocabulary: EvalVocabulary,
): Dto | (Omit<Dto, "iterations"> & { legacyIterations: number }) {
  if (vocabulary === 1) return dto;
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(dto)) {
    projected[key === "iterations" ? "legacyIterations" : key] = value;
  }
  return projected as Omit<Dto, "iterations"> & { legacyIterations: number };
}
