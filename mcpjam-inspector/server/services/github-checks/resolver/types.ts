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

/**
 * Whether the recipe's entry point is PROVEN to be checkout code.
 *
 * This exists because static analysis genuinely cannot settle the question in
 * every case, and pretending otherwise is how the detection allowlist sprang a
 * leak twice. A build script runs arbitrary code: `"build": "mkdir -p dist &&
 * cp node_modules/acme/server.js dist/index.js"` produces a `dist/index.js`
 * that is PUBLISHED code wearing a checkout-relative path. No amount of string
 * reasoning about the build body can tell that apart from `tsc`. Only watching
 * the process that actually ends up listening can.
 *
 * So the resolver stops guessing and starts LABELLING:
 *
 *   'verified'   — the entry point is a REGULAR FILE present in the checkout
 *                  listing, or the rung is authoritative (an operator or the
 *                  repo author declared it, and that declaration IS the truth
 *                  the ladder attributes to). Nothing further is owed.
 *   'unverified' — accepted, but its provenance was never established. Today
 *                  that is exactly one case: a relative, non-escaping entry
 *                  path that no listing contains and a build step plausibly
 *                  produces (`node dist/index.js` + `npm run build`), plus the
 *                  degenerate form of it — no listing was supplied at all, so
 *                  there was nothing to check against.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ WHAT A3 ACTUALLY DID WITH THIS — read before adding a gate on it.       │
 * │                                                                         │
 * │ An earlier plan had `resolveAndStart` settle 'unverified' at runtime:   │
 * │ resolve the LISTENING process's main module from `/proc/<pid>/cmdline`, │
 * │ `realpath` it, require it inside the checkout and outside node_modules. │
 * │ That was implemented and then REMOVED. `/proc/<pid>/cmdline` does not   │
 * │ say which argument is the program — `tsx src/index.ts` runs as `node    │
 * │ .../node_modules/tsx/dist/cli.mjs src/index.ts` and `uv run …` has no   │
 * │ file argument at all — so the rule rejected ordinary servers, while a   │
 * │ path-valued option accepted things that are not code. And it never      │
 * │ caught the motivating case anyway: a build that COPIES a dependency     │
 * │ into the checkout produces a main module inside the checkout.           │
 * │                                                                         │
 * │ So this field is a HONEST LABEL and no longer a gate. What actually     │
 * │ constrains a candidate is the static entry validation that produced the │
 * │ label (detect.ts rule C / verifyExtensionlessStart) plus A3's runtime   │
 * │ LISTENER IDENTITY check, which proves the thing answering the probe is  │
 * │ the command we spawned. The copied-dependency case is a documented,     │
 * │ accepted residual — see the module docblock in resolve-and-start.ts.    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
export type OwnershipProof = "verified" | "unverified";

export type ResolvedRecipe = CheckRecipe & {
  rung: RecipeRung;
  /** See `OwnershipProof` — and the A3 REQUIREMENT recorded with it. */
  ownershipProof: OwnershipProof;
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
