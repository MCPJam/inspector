/**
 * The recipe resolution ladder (R1 authoritative rungs + R2 detection).
 *
 * Ships dark: nothing imports this from the worker yet. Wiring happens in R4,
 * after the backend learns to persist rung provenance (R3). Until then the
 * worker keeps calling `resolveCheckRecipe` from ../recipes directly.
 *
 * Ladder order and the attribution contract live in ./types.ts. Today:
 *
 *   0. operator override  (authoritative) — present wins outright
 *   1. declared mcpjam.yaml (authoritative) — invalid FAILS, never falls through
 *   2. detected (heuristic) — MULTIPLE candidates, verified one at a time
 *   3+ agentic (heuristic) — lands in R5
 *
 * WHY THE RETURN SHAPE IS A UNION: rungs 0/1 produce a recipe that is already
 * true — an operator or the author said so, and there is nothing to choose
 * between. Rung 2 produces GUESSES, and a guess is only known good after it
 * builds and answers MCP. Collapsing them to one `ResolvedRecipe` would force
 * this module to pick a candidate on the caller's behalf, silently discarding
 * the fallbacks R4 needs (it runs each candidate in a FRESH sandbox). So the
 * ladder returns which KIND of answer it has, and the caller decides how much
 * verification that answer still owes.
 */

import { resolveOverrideRecipe } from "./overrides";
import { parseMcpjamYaml } from "./mcpjamYaml";
import { detectCandidatesWithReasons, type DetectionInputs } from "./detect";
import { RecipeResolutionError, type ResolvedRecipe } from "./types";

export {
  detectCandidates,
  detectCandidatesWithReasons,
  DETECTION_MAX_BYTES,
  DETECTION_README_MAX_BYTES,
  type DetectionInputs,
} from "./detect";
export { parseMcpjamYaml, MCPJAM_YAML_MAX_BYTES } from "./mcpjamYaml";
export { resolveOverrideRecipe } from "./overrides";
export {
  RecipeResolutionError,
  type RecipeRung,
  type ResolvedRecipe,
} from "./types";

export type LadderInput = {
  repoFullName: string;
  /** Contents of mcpjam.yaml at the repo root, or null if the file is absent. */
  mcpjamYaml: string | null;
  /**
   * Files for rung 2. Omit to run the authoritative rungs only — which is
   * exactly what `resolveRecipe` does, so the two entry points stay one code
   * path instead of drifting.
   */
  detection?: DetectionInputs;
};

export type LadderResolution =
  /** Rung 0/1: someone declared this. Run it; a failure is attributable. */
  | { kind: "authoritative"; recipe: ResolvedRecipe }
  /**
   * Rung 2+: guesses, best-first and always non-empty (an empty detection
   * result throws `no_recipe` instead). Each must be verified before it is
   * believed, and R4 verifies each in its own sandbox.
   */
  | { kind: "candidates"; candidates: ResolvedRecipe[] };

export function resolveRecipeLadder(input: LadderInput): LadderResolution {
  const override = resolveOverrideRecipe(input.repoFullName);
  if (override) {
    // An override outranks a declared config even when both exist; say so in
    // the evidence so an author staring at ignored yaml understands why.
    if (input.mcpjamYaml !== null) {
      override.evidence.push("mcpjam.yaml present but outranked by override");
    }
    return { kind: "authoritative", recipe: override };
  }

  // Authoritative rung: throws on an invalid file, by design (types.ts).
  // Detection is NOT consulted on the way past — a broken mcpjam.yaml that
  // fell through to a guess would run something the author never declared and
  // then blame them for the result.
  const declared = parseMcpjamYaml(input.mcpjamYaml);
  if (declared) return { kind: "authoritative", recipe: declared };

  const detected = input.detection
    ? detectCandidatesWithReasons(input.detection)
    : { candidates: [], discarded: [] as string[] };
  if (detected.candidates.length > 0) {
    return { kind: "candidates", candidates: detected.candidates };
  }

  // Maps to the existing `recipe_unresolvable` check outcome once the worker
  // adopts the ladder in R4 (a NEUTRAL check, never a failure blamed on the PR).
  // The discard reasons are constant strings from detect.ts, safe to render.
  throw new RecipeResolutionError(
    "no_recipe",
    `no recipe available for ${input.repoFullName}: no operator override, no mcpjam.yaml` +
      (input.detection ? ", and nothing detectable" : ""),
    detected.discarded.length > 0
      ? `Detection considered and rejected:\n${detected.discarded
          .map((reason) => `- ${reason}`)
          .join("\n")}`
      : undefined,
  );
}

/**
 * Authoritative-only entry point, unchanged from R1 (same signature, same
 * throws). Kept because a caller that only wants "is this configured?" should
 * not have to destructure a union it can never observe the second arm of.
 */
export function resolveRecipe(input: {
  repoFullName: string;
  mcpjamYaml: string | null;
}): ResolvedRecipe {
  const resolution = resolveRecipeLadder(input);
  // Unreachable: without `detection`, rung 2 produces nothing and the ladder
  // throws `no_recipe` above. Asserted rather than assumed.
  if (resolution.kind !== "authoritative") {
    throw new RecipeResolutionError(
      "no_recipe",
      `no recipe available for ${input.repoFullName}: no operator override and no mcpjam.yaml`,
    );
  }
  return resolution.recipe;
}
