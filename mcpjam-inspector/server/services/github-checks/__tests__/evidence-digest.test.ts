import { describe, expect, it } from "vitest";
import {
  computeRecipeEvidenceHash,
  computeResolverEvidenceDigest,
  encodeRecipeEvidence,
  isRecipeEvidenceHash,
  RECIPE_EVIDENCE_GOLDEN_VECTOR_SHA256,
  RECIPE_EVIDENCE_MAX_FILE_BYTES,
  DETECTOR_READ_LIMITS,
  RECIPE_EVIDENCE_PATHS,
  assertEvidenceBudgetsCoverDetector,
} from "../evidence-digest";

// This suite guards ONE encoder — the Inspector is the sole author of this
// digest now, and the backend stores it opaquely. So the properties that matter
// are:
//
//   1. THE GOLDEN VECTOR. A hard-coded digest over fixed inputs is the only
//      thing that catches a silent encoding change, and this particular value
//      is the one the retired backend encoder produced — so cache entries
//      written before the move are still addressable.
//   2. THE BUDGETS COVER THE DETECTOR. A byte detection can read but the digest
//      cannot see is a byte that changes the answer without changing the key,
//      which is a stale cache hit that re-probes green on the wrong server.
//   3. ABSENT ≠ EMPTY, and framing is unforgeable.

const GOLDEN = {
  resolverVersion: "golden-r1",
  promptVersion: "golden-p1",
  model: "golden-model",
  runtimeImageVersion: "golden-img-1",
  agenticContextDigest: "golden-ctx-1",
  files: {
    "package.json": '{"name":"golden","scripts":{"start":"node index.js"}}',
    "package-lock.json": '{"lockfileVersion":3}',
    README: "golden fixture: port 3001, path /mcp\n",
  },
} as const;

describe("evidence digest — the golden vector", () => {
  it("reproduces the pinned digest", () => {
    expect(computeRecipeEvidenceHash(GOLDEN)).toBe(
      RECIPE_EVIDENCE_GOLDEN_VECTOR_SHA256
    );
  });

  it("is a lowercase hex sha-256, which is all the backend checks", () => {
    expect(isRecipeEvidenceHash(computeRecipeEvidenceHash(GOLDEN))).toBe(true);
    expect(isRecipeEvidenceHash("")).toBe(false);
    expect(isRecipeEvidenceHash("ZZ".repeat(32))).toBe(false);
  });
});

describe("evidence digest — what must change the key", () => {
  it("changes when the resolver version changes", () => {
    // The detection LOGIC is an input to the answer: a resolver change must
    // MISS the cache rather than resurrect a recipe the old logic produced.
    expect(
      computeRecipeEvidenceHash({ ...GOLDEN, resolverVersion: "golden-r2" })
    ).not.toBe(RECIPE_EVIDENCE_GOLDEN_VECTOR_SHA256);
  });

  it("changes when one byte of one file changes", () => {
    expect(
      computeRecipeEvidenceHash({
        ...GOLDEN,
        files: { ...GOLDEN.files, "package.json": '{"name":"goldeN"}' },
      })
    ).not.toBe(RECIPE_EVIDENCE_GOLDEN_VECTOR_SHA256);
  });

  it("distinguishes ABSENT from PRESENT-AND-EMPTY", () => {
    // An empty `mcpjam.yaml` is a very different repository from one with no
    // `mcpjam.yaml` at all — the first is an authoritative rung that will refuse
    // the check, the second is no rung at all.
    const absent = computeRecipeEvidenceHash({
      resolverVersion: "r",
      files: {},
    });
    const empty = computeRecipeEvidenceHash({
      resolverVersion: "r",
      files: { "mcpjam.yaml": "" },
    });
    expect(absent).not.toBe(empty);
  });

  it("distinguishes the same content under different paths", () => {
    const a = computeRecipeEvidenceHash({
      resolverVersion: "r",
      files: { "package.json": "x" },
    });
    const b = computeRecipeEvidenceHash({
      resolverVersion: "r",
      files: { "server.json": "x" },
    });
    expect(a).not.toBe(b);
  });

  it("cannot be forged by embedding a separator in file content", () => {
    // Length-prefixed framing is the reason: file content is attacker-supplied,
    // and any separator can be embedded in it to make two different evidence
    // sets produce identical bytes.
    const a = computeRecipeEvidenceHash({
      resolverVersion: "r",
      files: { "package.json": "a", "package-lock.json": "b" },
    });
    const b = computeRecipeEvidenceHash({
      resolverVersion: "r",
      files: { "package.json": "a\0package-lock.json\0b" },
    });
    expect(a).not.toBe(b);
  });

  it("counts BYTES, not UTF-16 code units, when it truncates", () => {
    // `String.prototype.slice` would cut at a different place for non-ASCII
    // content, so two different files could hash the same (or one file could
    // hash differently) depending on where its multi-byte characters fall.
    const cap = RECIPE_EVIDENCE_MAX_FILE_BYTES["package.json"];
    const emoji = "😀"; // 4 UTF-8 bytes, 2 UTF-16 units
    const long = emoji.repeat(cap); // far past the cap either way
    const bytes = encodeRecipeEvidence({
      resolverVersion: "r",
      files: { "package.json": long },
    });
    // The framed segment for package.json's content is exactly the cap.
    expect(bytes.byteLength).toBeGreaterThan(cap);
    expect(
      computeRecipeEvidenceHash({
        resolverVersion: "r",
        files: { "package.json": long },
      })
    ).toBe(
      computeRecipeEvidenceHash({
        resolverVersion: "r",
        // Same first `cap` BYTES, different tail: the tail is past the budget.
        files: { "package.json": long + "tail" },
      })
    );
  });
});

describe("evidence digest — budgets", () => {
  it("covers every byte the detector can read, for every path", () => {
    for (const path of RECIPE_EVIDENCE_PATHS) {
      expect(RECIPE_EVIDENCE_MAX_FILE_BYTES[path]).toBeGreaterThanOrEqual(
        DETECTOR_READ_LIMITS[path]
      );
    }
    expect(() => assertEvidenceBudgetsCoverDetector()).not.toThrow();
  });
});

describe("computeResolverEvidenceDigest", () => {
  const inputs = {
    mcpjamYaml: { kind: "absent" } as const,
    detection: {
      packageJson: '{"name":"x"}',
      packageLockJson: "{}",
      pnpmLockYaml: null,
      yarnLock: null,
      pyprojectToml: null,
      uvLock: null,
      serverJson: null,
      readme: null,
      repoFiles: [],
    },
  };

  it("hashes exactly what the resolver was fed", () => {
    expect(computeResolverEvidenceDigest(inputs, "r2/1")).toBe(
      computeRecipeEvidenceHash({
        resolverVersion: "r2/1",
        files: {
          "package.json": '{"name":"x"}',
          "package-lock.json": "{}",
        },
      })
    );
  });

  it("treats an OVER-CAP mcpjam.yaml as absent for the KEY only", () => {
    // The ladder refuses an over-cap declared config outright (`recipe_invalid`),
    // so this digest is never used to look one up. What matters here is that the
    // digest reflects what detection SAW — an unreadable file contributed
    // nothing to the answer — rather than inventing content for it.
    const overCap = computeResolverEvidenceDigest(
      { ...inputs, mcpjamYaml: { kind: "over_cap" } },
      "r2/1"
    );
    expect(overCap).toBe(computeResolverEvidenceDigest(inputs, "r2/1"));
  });

  it("moves when the declared config's content moves", () => {
    expect(
      computeResolverEvidenceDigest(
        { ...inputs, mcpjamYaml: { kind: "present", text: "version: 1\n" } },
        "r2/1"
      )
    ).not.toBe(computeResolverEvidenceDigest(inputs, "r2/1"));
  });
});
