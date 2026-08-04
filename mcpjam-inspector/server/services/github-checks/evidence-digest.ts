/**
 * The canonical run-recipe EVIDENCE DIGEST — and the Inspector is its only
 * author.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS HERE AND NOWHERE ELSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * This encoding used to live in the backend (`convex/github/recipeEvidence.ts`)
 * and was to be HAND-MIRRORED here, with a golden vector acting as a cross-repo
 * treaty. A3b-1 retired that: the backend now treats the digest as OPAQUE — it
 * stores and compares the value as a cache key and never recomputes it, and its
 * only remaining check is that the string is shaped like a hex sha-256.
 *
 * So there is exactly ONE encoder, and it is this one. That removes the entire
 * class of failure where two implementations disagree on one byte and silently
 * become two cache namespaces wearing the same key. What it does NOT remove is
 * the need for the format to stay STABLE: every cache entry ever written is
 * keyed by it, so changing the encoding without bumping
 * `RECIPE_EVIDENCE_HASH_VERSION` orphans the cache instead of invalidating it.
 * The golden vector below is no longer a treaty — it is a plain regression test
 * guarding that stability.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RULES, AND WHY EACH ONE IS LOAD-BEARING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   1. The input paths are a FIXED, ORDERED list (`RECIPE_EVIDENCE_PATHS`).
 *      Order is the list's order, never the caller's iteration order, and never
 *      sorted at runtime — the list IS the ordering.
 *   2. Each path contributes three segments: the path, a `present`/`absent`
 *      marker, and the first `RECIPE_EVIDENCE_MAX_FILE_BYTES[path]` BYTES of
 *      its content (UTF-8, byte-measured — NOT `String.prototype.slice`, which
 *      counts UTF-16 code units and would make two different files hash the
 *      same, or the same file hash differently, depending on where its
 *      non-ASCII characters fall).
 *   3. Segments are concatenated LENGTH-PREFIXED (4-byte big-endian byte
 *      length). Plain concatenation with a separator is forgeable: file content
 *      is attacker-controlled, and any separator can be embedded in it to make
 *      two different evidence sets produce identical bytes.
 *   4. The hash also covers `resolverVersion` — the detection LOGIC is an input
 *      to the answer, so a resolver change must MISS the cache rather than
 *      resurrect a recipe the old logic produced.
 *   5. For agentic entries it additionally covers `promptVersion`, `model`,
 *      `runtimeImageVersion` and `agenticContextDigest`. Nothing produces those
 *      today (the agentic rung is backend-owned and lands in A4), but they are
 *      part of the encoding and removing them would move every existing key.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY RE-PROBING DOES NOT EXCUSE A NARROW HASH. READ THIS BEFORE TUNING IT.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * It is tempting to argue the byte budget can be anything, because the worker
 * re-builds and re-probes every cache hit anyway. That argument is wrong, and
 * subtly so:
 *
 *   Re-probing only proves the STALE CANDIDATE STILL RUNS.
 *   It does not prove it is the candidate THIS CHECKOUT SHOULD HAVE SELECTED.
 *
 * Concretely: a PR moves the real entry point and adds `"start": "node
 * dist/new.js"` 30KB into a `package.json`. The old cached `node dist/old.js`
 * still builds and still speaks MCP, so it re-probes green — and the check
 * reports on the wrong server, forever, because the digest never moved. So the
 * invariant is not "roughly representative", it is:
 *
 *   THE DIGEST MUST COVER EVERY BYTE DETECTION IS CAPABLE OF READING.
 *
 * Covering MORE than detection reads is safe (extra misses); covering LESS is a
 * correctness bug. `assertEvidenceBudgetsCoverDetector()` enforces the
 * direction at module load, and the budgets are taken from the detector's OWN
 * constants rather than copied — the two cannot drift apart at all now that
 * both live in this repository.
 */

import { createHash } from "node:crypto";
import {
  DETECTION_MAX_BYTES,
  DETECTION_README_MAX_BYTES,
  MCPJAM_YAML_MAX_BYTES,
  type DetectionInputs,
} from "./resolver/index.js";
import type { CappedRead } from "./sandbox-inspect.js";

/**
 * The fixed, ordered evidence path list. Appending to the END is the only
 * backwards-tolerable edit, and even that changes every digest (an appended
 * path contributes an `absent` marker to repositories that lack it) — which is
 * correct, and is exactly why `RECIPE_EVIDENCE_HASH_VERSION` exists.
 *
 * `README` is the section a resolver reads for port/path HINTS, not a path read
 * verbatim; callers pass the text they actually read (or omit it).
 */
export const RECIPE_EVIDENCE_PATHS = [
  "mcpjam.yaml",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pyproject.toml",
  "uv.lock",
  "server.json",
  "README",
] as const;

export type RecipeEvidencePath = (typeof RECIPE_EVIDENCE_PATHS)[number];

/**
 * What the DETECTOR reads, per path. Not a policy knob — a projection of the
 * resolver's real constants, imported rather than copied.
 *
 * The lockfiles are the one place this is deliberately GENEROUS. Detection only
 * tests them for PRESENCE today, so a zero budget would technically do. They
 * are budgeted at the manifest cap anyway: the day detection starts reading a
 * lockfile's contents — pinned versions are the obvious next signal — the
 * digest already covers them, instead of the change landing as a fleet of stale
 * hits nobody connects to the edit.
 */
export const DETECTOR_READ_LIMITS: Record<RecipeEvidencePath, number> = {
  "mcpjam.yaml": MCPJAM_YAML_MAX_BYTES,
  "package.json": DETECTION_MAX_BYTES,
  "package-lock.json": DETECTION_MAX_BYTES,
  "pnpm-lock.yaml": DETECTION_MAX_BYTES,
  "yarn.lock": DETECTION_MAX_BYTES,
  "pyproject.toml": DETECTION_MAX_BYTES,
  "uv.lock": DETECTION_MAX_BYTES,
  "server.json": DETECTION_MAX_BYTES,
  README: DETECTION_README_MAX_BYTES,
};

/** Per-path byte budget for the DIGEST. At or above the detector's own limit. */
export const RECIPE_EVIDENCE_MAX_FILE_BYTES: Record<
  RecipeEvidencePath,
  number
> = { ...DETECTOR_READ_LIMITS };

/**
 * The coupling, enforced rather than commented. Runs at module load (both
 * tables are constants, so it can only fire on an edit) and throws, because a
 * budget that has silently fallen below the detector's read limit is a
 * correctness bug that produces green checks on the wrong server — failing the
 * boot is the cheap outcome.
 */
export function assertEvidenceBudgetsCoverDetector(): void {
  for (const path of RECIPE_EVIDENCE_PATHS) {
    const budget = RECIPE_EVIDENCE_MAX_FILE_BYTES[path];
    const read = DETECTOR_READ_LIMITS[path];
    if (!(budget >= read)) {
      throw new Error(
        `recipe evidence budget for '${path}' is ${budget} bytes but the ` +
          `detector reads ${read} — bytes detection can read that the cache ` +
          `key cannot see let a stale recipe win on a checkout that should ` +
          `have selected a different one`
      );
    }
  }
}
assertEvidenceBudgetsCoverDetector();

/**
 * Bumped whenever the ENCODING changes (path list, markers, framing, digest, or
 * any per-path byte budget). It is the first segment, so a bump invalidates
 * every cache entry at once — which is what makes changing this file safe.
 *
 * /2 — per-path byte budgets aligned with the detector's read limits (was a
 *      flat 8KB), and `agenticContextDigest` added to the covered scalars.
 *      Carried across from the backend unchanged: the value is what existing
 *      cache entries were written under, so renaming it would orphan them.
 */
export const RECIPE_EVIDENCE_HASH_VERSION = "mcpjam.recipe-evidence/2";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE GOLDEN VECTOR — a regression test, no longer a cross-repo treaty.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Same inputs → same hash" and "one byte differs → different hash" are
 * properties of ANY encoder, including one that silently changed. A fixed input
 * with a hard-coded digest is what pins THIS encoder's bytes, and the value
 * below is the one the backend's encoder produced before it was retired — so a
 * cache entry written by the old backend path is still addressable by this one.
 *
 *   resolverVersion      = "golden-r1"
 *   promptVersion        = "golden-p1"
 *   model                = "golden-model"
 *   runtimeImageVersion  = "golden-img-1"
 *   agenticContextDigest = "golden-ctx-1"
 *   files:
 *     package.json      = {"name":"golden","scripts":{"start":"node index.js"}}
 *     package-lock.json = {"lockfileVersion":3}
 *     README            = golden fixture: port 3001, path /mcp\n
 *     (everything else ABSENT)
 *
 * Changing the encoding means bumping `RECIPE_EVIDENCE_HASH_VERSION` and this
 * digest together, deliberately, in one commit.
 */
export const RECIPE_EVIDENCE_GOLDEN_VECTOR_SHA256 =
  "139b76e3c34696b550e48d39f8ae5705027db66bb19b44ab37e7dd0b6e6ecb06";

export type RecipeEvidenceInput = {
  /**
   * Version of the resolver LOGIC that would consume this evidence. Required:
   * defaulting it would let a digest outlive the code that produced its answer.
   */
  resolverVersion: string;
  /**
   * Path → content prefix. An omitted key and an explicit `null`/`undefined`
   * both mean ABSENT; an empty string means PRESENT AND EMPTY, and the two hash
   * differently (an empty `mcpjam.yaml` is a very different repository from one
   * with no `mcpjam.yaml` at all). Unknown keys are ignored — only
   * `RECIPE_EVIDENCE_PATHS` contributes.
   */
  files: Partial<Record<RecipeEvidencePath, string | null | undefined>>;
  /** Agentic rung only: the prompt template's version. */
  promptVersion?: string | null;
  /** Agentic rung only: the model id that proposed the candidate. */
  model?: string | null;
  /** Agentic rung only: the sandbox base image the candidate was built on. */
  runtimeImageVersion?: string | null;
  /**
   * Agentic rung only: a digest of ANY repo content fed to the agent beyond the
   * `RECIPE_EVIDENCE_PATHS` prefixes above. Whatever the agentic rung reads, it
   * digests into here — otherwise the stale-key failure mode above reappears
   * one rung down, where the agent's inputs are exactly the files this fixed
   * path list does not observe.
   */
  agenticContextDigest?: string | null;
};

const encoder = new TextEncoder();

/**
 * First `maxBytes` bytes of the UTF-8 encoding of `text`.
 *
 * A cut may land mid-codepoint. That is fine and deliberate: we hash BYTES, and
 * the cut position is a pure function of the content. Preserving codepoint
 * boundaries would make the boundary depend on the decoder.
 */
function utf8Prefix(text: string, maxBytes: number): Uint8Array {
  const bytes = encoder.encode(text);
  return bytes.length <= maxBytes ? bytes : bytes.subarray(0, maxBytes);
}

/**
 * Length-prefixed framing: each segment is `u32be(byteLength) || bytes`. With
 * this, no arrangement of attacker-supplied content can imitate a different
 * segmentation.
 */
function frame(segments: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const segment of segments) total += 4 + segment.byteLength;
  const buffer = new ArrayBuffer(total);
  const out = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let offset = 0;
  for (const segment of segments) {
    view.setUint32(offset, segment.byteLength, false);
    offset += 4;
    out.set(segment, offset);
    offset += segment.byteLength;
  }
  return out;
}

/**
 * Build the exact byte string that gets hashed. Exported for tests and for
 * localizing a disagreement: comparing these bytes says WHERE two inputs
 * diverged, which comparing two hex digests cannot.
 */
export function encodeRecipeEvidence(input: RecipeEvidenceInput): Uint8Array {
  const segments: Uint8Array[] = [encoder.encode(RECIPE_EVIDENCE_HASH_VERSION)];

  // Scalars first, each with its own present/absent marker so `undefined` and
  // `''` are distinguishable, and each LABELLED so moving a value between
  // fields changes the digest.
  const scalars: Array<[string, string | null | undefined]> = [
    ["resolverVersion", input.resolverVersion],
    ["promptVersion", input.promptVersion],
    ["model", input.model],
    ["runtimeImageVersion", input.runtimeImageVersion],
    ["agenticContextDigest", input.agenticContextDigest],
  ];
  for (const [name, value] of scalars) {
    segments.push(encoder.encode(name));
    const present = typeof value === "string";
    segments.push(encoder.encode(present ? "present" : "absent"));
    segments.push(encoder.encode(present ? value : ""));
  }

  // Then the files, in the LIST's order — never the caller's.
  for (const path of RECIPE_EVIDENCE_PATHS) {
    const content = input.files?.[path];
    const present = typeof content === "string";
    segments.push(encoder.encode(path));
    segments.push(encoder.encode(present ? "present" : "absent"));
    segments.push(
      present
        ? utf8Prefix(content, RECIPE_EVIDENCE_MAX_FILE_BYTES[path])
        : new Uint8Array(0)
    );
  }

  return frame(segments);
}

/** The canonical digest: lowercase hex sha-256 over `encodeRecipeEvidence`. */
export function computeRecipeEvidenceHash(input: RecipeEvidenceInput): string {
  return createHash("sha256").update(encodeRecipeEvidence(input)).digest("hex");
}

/** Cheap shape check — the same one the backend applies to what it receives. */
export function isRecipeEvidenceHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * The digest for a checkout, computed from EXACTLY what the resolver was fed.
 *
 * Taking the reader's own output — rather than re-reading, or accepting a
 * hand-assembled map — is what keeps rule 4 true in practice: the bytes hashed
 * are the bytes detection saw, including the reader's caps and its `over_cap`
 * collapse. A file the reader could not read is `absent` here for the same
 * reason it is absent to the detector: it contributed nothing to the answer.
 *
 * ONE INPUT IS NOT COVERED, AND IT IS NOT AIRTIGHT: `DetectionInputs.repoFiles`.
 *
 * The listing is a real detection input — it is what turns rule C from a guess
 * into a proof, and it can SUPPRESS a candidate (a symlinked entry point, a
 * python `[project.scripts]` entry) that the syntactic rules alone would let
 * through. By the invariant above it therefore belongs in the digest, and it is
 * absent. `resolver/detect.ts` justifies the omission on the grounds that the
 * listing is derived from the same commit the hashed files are read at.
 *
 * What that argument does and does not buy, stated plainly so the next person
 * does not have to re-derive it:
 *
 *   - Cross-repository replay is NOT possible regardless: the backend's recipe
 *     cache is keyed by `by_repo_evidence` — `(repoFullName, evidenceHash)` —
 *     so a digest collision between two different repositories cannot hit.
 *   - WITHIN one repository it is not tight. A commit can leave every hashed
 *     byte identical and still change the listing — most sharply, by replacing
 *     a tracked `server.js` with a SYMLINK into `node_modules/`. Fresh
 *     detection suppresses that candidate; a cache hit issued when the same
 *     path was a regular file does not, which is the exact ownership proof
 *     `repoFiles` was added to establish.
 *
 * Closing it means hashing a bounded, deterministic encoding of the listing
 * (path + kind) and bumping `RECIPE_EVIDENCE_HASH_VERSION`, which orphans every
 * entry written so far — a deliberate cost, and a decision that belongs with
 * the cache owner rather than in a drive-by. Tracked, not settled.
 */
export function computeResolverEvidenceDigest(
  inputs: { mcpjamYaml: CappedRead; detection: DetectionInputs },
  resolverVersion: string
): string {
  return computeRecipeEvidenceHash({
    resolverVersion,
    files: {
      "mcpjam.yaml":
        inputs.mcpjamYaml.kind === "present" ? inputs.mcpjamYaml.text : null,
      "package.json": inputs.detection.packageJson,
      "package-lock.json": inputs.detection.packageLockJson,
      "pnpm-lock.yaml": inputs.detection.pnpmLockYaml,
      "yarn.lock": inputs.detection.yarnLock,
      "pyproject.toml": inputs.detection.pyprojectToml,
      "uv.lock": inputs.detection.uvLock,
      "server.json": inputs.detection.serverJson,
      README: inputs.detection.readme,
    },
  });
}
