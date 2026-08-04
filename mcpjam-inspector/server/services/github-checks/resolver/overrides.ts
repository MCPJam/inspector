/**
 * Rung 0: the operator override table.
 *
 * This adds rung/evidence attribution on top of the `../recipes` table without
 * changing that table's shape or behavior.
 *
 * Overrides are AUTHORITATIVE (types.ts): an operator put the entry there
 * deliberately, so when one exists it wins over anything the repo declares.
 * That is precisely why the production table is EMPTY (see `../recipes`) — an
 * entry masks the repo's own `mcpjam.yaml`.
 *
 * The attribution is exposed as a resolver BUILT OVER A TABLE
 * (`makeOverrideResolver`) rather than as a function closed over the production
 * one, so override BEHAVIOUR can be exercised with a synthetic table. Override
 * semantics are a property of the ladder, not of what an operator happens to
 * have configured today, and coupling the two meant the tests could only test
 * whatever production config contained.
 */

import { lookupRecipe, RECIPES_TABLE, type RecipeTable } from "../recipes";
import type { ResolvedRecipe } from "./types";

/** Rung 0's lookup: `owner/repo` → an attributed override recipe, or null. */
export type OverrideResolver = (repoFullName: string) => ResolvedRecipe | null;

/** Build a rung-0 resolver over an explicit table (tests pass a synthetic one). */
export function makeOverrideResolver(table: RecipeTable): OverrideResolver {
  return (repoFullName: string): ResolvedRecipe | null => {
    const recipe = lookupRecipe(table, repoFullName);
    if (!recipe) return null;
    return {
      ...recipe,
      rung: "override",
      // AUTHORITATIVE rung: an operator wrote this command down deliberately,
      // so the declaration IS the ownership fact the ladder attributes to.
      // There is nothing left for A3's runtime check to establish.
      ownershipProof: "verified",
      // repoFullName is operator/allowlist-controlled, not PR content, so it is
      // safe to echo into evidence.
      evidence: [`operator override for ${repoFullName.trim().toLowerCase()}`],
    };
  };
}

/** The production rung 0, over the (empty) production override table. */
export const resolveOverrideRecipe: OverrideResolver =
  makeOverrideResolver(RECIPES_TABLE);
