/**
 * Recipe resolver vocabulary.
 *
 * THE ATTRIBUTION CONTRACT (this is the whole point of the ladder):
 *
 * Rungs split into two classes, and the class decides what happens when a
 * rung is present but broken:
 *
 *   - AUTHORITATIVE rungs ('override', 'declared'): someone deliberately
 *     wrote this configuration down — an operator in the override table, or
 *     the repo author in mcpjam.yaml. If it exists but is invalid, resolution
 *     FAILS with `RecipeResolutionError`. Falling through to a heuristic
 *     would silently mask a real regression in the author's own config and
 *     run something they never asked for.
 *
 *   - HEURISTIC rungs ('detected', 'agentic'): our best guess. A guess that
 *     doesn't pan out may fall through to the next rung, because nobody
 *     promised us anything.
 *
 * The check output later shows WHICH rung produced the recipe (via
 * `evidence`), so a red X is always attributable to a specific source of
 * truth.
 */

import type { CheckRecipe } from "../recipes";

/**
 * The FULL final union, declared up front even though only the first two
 * rungs exist today: the backend provenance receiver (R3) persists this
 * vocabulary, so it must be complete from day one to avoid a cross-repo
 * migration later.
 *
 * - 'override'  — operator override table (rung 0, authoritative)
 * - 'declared'  — mcpjam.yaml in the repo (rung 1, authoritative)
 * - 'detected'  — repo-shape heuristics, lands in R2 (heuristic)
 * - 'agentic'   — agentic fallback, lands in R5 (heuristic)
 */
export type RecipeRung = "override" | "declared" | "detected" | "agentic";

export type ResolvedRecipe = CheckRecipe & {
  rung: RecipeRung;
  /**
   * Short human-readable strings surfaced in check output ("mcpjam.yaml at
   * repo root", "operator override for <repo>"). These MUST stay free of
   * untrusted file content — the yaml comes out of a PR checkout, and
   * evidence flows into GitHub check summaries unescaped.
   */
  evidence: string[];
};

/**
 * Failure of an AUTHORITATIVE rung (see the contract above). Heuristic rungs
 * never throw this — they return null and the ladder moves on.
 */
export class RecipeResolutionError extends Error {
  /** Stable machine-readable reason, e.g. 'invalid_mcpjam_yaml', 'no_recipe'. */
  readonly reason: string;
  /** Optional detail block rendered into the check output for the author. */
  readonly detailsMarkdown?: string;

  constructor(reason: string, message: string, detailsMarkdown?: string) {
    super(message);
    this.name = "RecipeResolutionError";
    this.reason = reason;
    this.detailsMarkdown = detailsMarkdown;
  }
}
