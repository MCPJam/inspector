/**
 * Rung 0: the operator override table.
 *
 * This wraps the existing hardcoded `RECIPES` table rather than replacing it:
 * the live worker still calls `resolveCheckRecipe` directly until the ladder
 * is wired in (R4), so the table keeps its current shape and behavior and
 * this module only adds the rung/evidence attribution on top.
 *
 * Overrides are AUTHORITATIVE (types.ts): an operator put the entry there
 * deliberately, so when one exists it wins over anything the repo declares.
 */

import { resolveCheckRecipe } from "../recipes";
import type { ResolvedRecipe } from "./types";

export function resolveOverrideRecipe(
  repoFullName: string,
): ResolvedRecipe | null {
  const recipe = resolveCheckRecipe(repoFullName);
  if (!recipe) return null;
  return {
    ...recipe,
    rung: "override",
    // AUTHORITATIVE rung: an operator wrote this command down deliberately, so
    // the declaration IS the ownership fact the ladder attributes to. There is
    // nothing left for A3's runtime check to establish.
    ownershipProof: "verified",
    // repoFullName is operator/allowlist-controlled, not PR content, so it is
    // safe to echo into evidence.
    evidence: [`operator override for ${repoFullName.trim().toLowerCase()}`],
  };
}
