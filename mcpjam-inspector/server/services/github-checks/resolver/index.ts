/**
 * The recipe resolution ladder (R1: authoritative rungs only).
 *
 * Ships dark: nothing imports this from the worker yet. Wiring happens in R4,
 * after the backend learns to persist rung provenance (R3). Until then the
 * worker keeps calling `resolveCheckRecipe` from ../recipes directly.
 *
 * Ladder order and the attribution contract live in ./types.ts. Today:
 *
 *   0. operator override  (authoritative) — present wins outright
 *   1. declared mcpjam.yaml (authoritative) — invalid FAILS, never falls through
 *   2+ detected / agentic (heuristic) — land in R2 / R5
 */

import { resolveOverrideRecipe } from "./overrides";
import { parseMcpjamYaml } from "./mcpjamYaml";
import { RecipeResolutionError, type ResolvedRecipe } from "./types";

export { parseMcpjamYaml, MCPJAM_YAML_MAX_LENGTH } from "./mcpjamYaml";
export { resolveOverrideRecipe } from "./overrides";
export {
  RecipeResolutionError,
  type RecipeRung,
  type ResolvedRecipe,
} from "./types";

export function resolveRecipe(input: {
  repoFullName: string;
  /** Contents of mcpjam.yaml at the repo root, or null if the file is absent. */
  mcpjamYaml: string | null;
}): ResolvedRecipe {
  const override = resolveOverrideRecipe(input.repoFullName);
  if (override) {
    // An override outranks a declared config even when both exist; say so in
    // the evidence so an author staring at ignored yaml understands why.
    if (input.mcpjamYaml !== null) {
      override.evidence.push("mcpjam.yaml present but outranked by override");
    }
    return override;
  }

  // Authoritative rung: throws on an invalid file, by design (types.ts).
  const declared = parseMcpjamYaml(input.mcpjamYaml);
  if (declared) return declared;

  // Maps to the existing `recipe_unresolvable` check outcome once the worker
  // adopts the ladder in R4 (a NEUTRAL check, never a failure blamed on the PR).
  throw new RecipeResolutionError(
    "no_recipe",
    `no recipe available for ${input.repoFullName}: no operator override and no mcpjam.yaml`,
  );
}
