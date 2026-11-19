/**
 * Parity with the backend's hand-mirrored hashing. `variant-hash-vectors.json`
 * is a copy of the contract's shared vectors (computed in Node, checked in
 * Python); the backend tests a copy of the same file. Each vector's
 * `canonical` must survive a parse and re-canonicalization byte for byte and
 * hash to its `sha256`.
 */

import { describe, expect, it } from "vitest";

import {
  buildVariantDraft,
  canonicalJson,
  computeContentHash,
  computeEditsHash,
  computeSurfaceHash,
  computeToolHash,
  sha256Hex,
  type VariantEdit,
  type VariantTool,
} from "../../src/variants/index.js";
import { expectNoNodeBuiltins } from "../support/node-builtin-guard.js";
import vectors from "../fixtures/variant-hash-vectors.json" with { type: "json" };

const BASE_SERVER_ID = "qx82k5gs2tmhfw1saa8910gydh8jhqee";

function vector(name: string) {
  const found = vectors.find((entry) => entry.name === name);
  if (!found)
    throw new Error(`variant-hash-vectors.json has no ${name} vector`);
  return found;
}

describe("variant hash parity vectors", () => {
  it("holds the five vectors the contract names", () => {
    expect(vectors.map((entry) => entry.name)).toEqual([
      "nested",
      "tool",
      "edits",
      "surface",
      "contentHash",
    ]);
  });

  for (const { name, canonical, sha256 } of vectors) {
    it(`${name}: re-canonicalizes byte for byte and hashes to its sha256`, async () => {
      const value: unknown = JSON.parse(canonical);
      const again = canonicalJson(value);
      expect(again).toBe(canonical);
      expect(await sha256Hex(again)).toBe(sha256);
    });
  }

  it("nested: drops a key whose value is undefined", () => {
    const literal = {
      b: 1,
      a: [3, { d: null, c: "x", e: undefined }],
      z: true,
    };
    expect(canonicalJson(literal)).toBe(vector("nested").canonical);
  });

  it("each named hash helper reproduces its vector", async () => {
    const tool = JSON.parse(vector("tool").canonical) as VariantTool;
    const edits = JSON.parse(vector("edits").canonical) as VariantEdit[];
    const { tools } = JSON.parse(vector("surface").canonical) as {
      tools: VariantTool[];
    };

    expect(await computeToolHash(tool)).toBe(vector("tool").sha256);
    expect(await computeEditsHash(edits)).toBe(vector("edits").sha256);
    expect(await computeSurfaceHash(tools)).toBe(vector("surface").sha256);
    expect(
      await computeContentHash({
        baseServerId: BASE_SERVER_ID,
        baseSurfaceHash: vector("surface").sha256,
        editsHash: vector("edits").sha256,
      })
    ).toBe(vector("contentHash").sha256);
  });

  it("a draft built from the vectors' surface and edits carries their hashes", async () => {
    const { tools } = JSON.parse(vector("surface").canonical) as {
      tools: VariantTool[];
    };
    const edits = JSON.parse(vector("edits").canonical) as VariantEdit[];

    const draft = await buildVariantDraft({
      baseServerId: BASE_SERVER_ID,
      tools,
      edits,
    });

    expect(draft.editsHash).toBe(vector("edits").sha256);
    expect(draft.baseSurfaceHash).toBe(vector("surface").sha256);
    expect(draft.contentHash).toBe(vector("contentHash").sha256);
    expect(draft.toolHashes).toEqual([
      { tool: "show_servers", hash: vector("tool").sha256 },
    ]);
  });
});

describe("@mcpjam/sdk/variants runtime", () => {
  it("bundles with no Node builtin in its graph, so it runs in Workers", async () => {
    await expectNoNodeBuiltins(
      new URL("../../src/variants/index.ts", import.meta.url)
    );
  });
});
