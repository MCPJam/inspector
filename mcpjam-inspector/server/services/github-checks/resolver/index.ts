/**
 * The recipe resolution ladder (R1 authoritative rungs + R2 detection).
 *
 * Ships dark: nothing imports this from the worker yet. Wiring happens in R4,
 * after the backend learns to persist rung provenance (R3). Until then the
 * worker keeps calling `resolveCheckRecipe` from ../recipes directly.
 *
 * Ladder order and the attribution contract live in ./types.ts. Today:
 *
 *   0. operator override  (authoritative) — present wins outright, which is
 *      why the production table is empty (see ../recipes); tests inject a
 *      synthetic table via `LadderInput.resolveOverride`
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

import { resolveOverrideRecipe, type OverrideResolver } from "./overrides";
import { parseMcpjamYaml, MCPJAM_YAML_MAX_BYTES } from "./mcpjamYaml";
import { detectCandidatesWithReasons, type DetectionInputs } from "./detect";
import { RecipeResolutionError, type ResolvedRecipe } from "./types";

export {
  detectCandidates,
  detectCandidatesWithReasons,
  DETECTION_MAX_BYTES,
  DETECTION_README_MAX_BYTES,
  type DetectionInputs,
  type RepoFileEntry,
  type RepoFileKind,
} from "./detect";
export {
  listRepoFiles,
  parseLsFilesEntries,
  MAX_REPO_FILES,
} from "./repoFiles";
export { parseMcpjamYaml, MCPJAM_YAML_MAX_BYTES } from "./mcpjamYaml";
export {
  makeOverrideResolver,
  resolveOverrideRecipe,
  type OverrideResolver,
} from "./overrides";
export {
  RecipeResolutionError,
  type OwnershipProof,
  type RecipeRung,
  type ResolvedRecipe,
} from "./types";

/**
 * The version of the resolver LOGIC, not of this file.
 *
 * It is covered by the evidence digest (`../evidence-digest.ts`) and travels to
 * the backend with every plan request, so it is what stops a cached recipe
 * outliving the detection rules that produced it: change how the ladder decides
 * anything and the cache MISSES rather than resurrecting an answer the current
 * logic would not have given. Bump it when detection's behaviour changes —
 * never for a refactor that cannot change an outcome.
 */
export const RESOLVER_VERSION = "r2/1";

export type LadderInput = {
  repoFullName: string;
  /** Contents of mcpjam.yaml at the repo root, or null if the file is absent. */
  mcpjamYaml: string | null;
  /**
   * The declared config EXISTS but was too large to read, so `mcpjamYaml` is
   * null for a reason that is not absence.
   *
   * This flag is what stops a reader's byte cap from silently downgrading an
   * authoritative rung. `parseMcpjamYaml` already calls an over-size file
   * `invalid_mcpjam_yaml` when it is handed one — but a sandbox reader cannot
   * hand it one, by construction, because pulling an unbounded file across the
   * command channel is the thing the cap exists to prevent. Without this flag it
   * had to report `null`, `null` means absent, and absence means "this rung does
   * not apply" — so an oversized (therefore invalid) declared config fell
   * through to heuristic candidates and could green a PR on a command its author
   * never wrote. Authoritative rungs do not fall through; this is how that stays
   * true when the file cannot be read.
   *
   * Checked AFTER the override rung, because an operator override outranks a
   * declared config whether or not that config is readable.
   */
  mcpjamYamlOverCap?: boolean;
  /**
   * Files for rung 2. Omit to run the authoritative rungs only — which is
   * exactly what `resolveRecipe` does, so the two entry points stay one code
   * path instead of drifting.
   *
   * Include `detection.repoFiles` (the checkout's file listing, WITH a kind per
   * entry — see `RepoFileEntry`) whenever the caller has the checkout on disk.
   * It is not simply a permissiveness dial: with a listing detection can PROVE
   * an entry point is checkout code and mark the candidate
   * `ownershipProof: 'verified'`, and it can also REFUSE things it would
   * otherwise have to let through (a symlinked entry point, a bare-word start
   * resolved from `node_modules/.bin`). Without one, node candidates fall back
   * to syntactic rules and come out 'unverified', and python is suppressed
   * outright. Use `listRepoFiles()` to build it — one shape, one command, for
   * both callers. `scripts/resolver-corpus.ts` populates it from the clone; A3
   * populates it from the sandbox.
   */
  detection?: DetectionInputs;
  /**
   * Rung 0's lookup. Defaults to the production operator override table, which
   * is where every real caller leaves it.
   *
   * It is a PARAMETER because rung 0's ordering — an override outranks a
   * declared config, an over-cap one, and detection — is a property of this
   * ladder, and a property that can only be exercised through module-level
   * production config is not really tested at all. The production table is
   * (correctly) empty, and before this seam existed emptying it silently
   * deleted the coverage for the highest rung. Tests build a synthetic table
   * with `makeOverrideResolver` instead.
   */
  resolveOverride?: OverrideResolver;
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
  const override = (input.resolveOverride ?? resolveOverrideRecipe)(
    input.repoFullName,
  );
  if (override) {
    // An override outranks a declared config even when both exist; say so in
    // the evidence so an author staring at ignored yaml understands why.
    if (input.mcpjamYaml !== null || input.mcpjamYamlOverCap) {
      override.evidence.push("mcpjam.yaml present but outranked by override");
    }
    return { kind: "authoritative", recipe: override };
  }

  // Present but unreadable-by-cap. Same verdict `parseMcpjamYaml` reaches when
  // it is handed the file itself, and the same message, so the author sees one
  // explanation whichever side of the cap the file was measured on.
  if (input.mcpjamYamlOverCap) {
    throw new RecipeResolutionError(
      "invalid_mcpjam_yaml",
      `mcpjam.yaml: file exceeds the ${
        MCPJAM_YAML_MAX_BYTES / 1024
      }KB limit for declared config`,
    );
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
export function resolveRecipe(
  input: Pick<LadderInput, "repoFullName" | "mcpjamYaml" | "resolveOverride">,
): ResolvedRecipe {
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
