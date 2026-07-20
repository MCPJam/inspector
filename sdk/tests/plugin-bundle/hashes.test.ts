/**
 * Deterministic hashing — same input twice yields identical hashes, one
 * changed byte changes the bundle hash, and listing order never matters.
 * All hashing runs on Web Crypto so Node and browser runtimes agree.
 */

import { describe, expect, it } from "vitest";
import { parsePluginBundle } from "../../src/plugin-bundle/index.js";
// Internal helpers are deliberately not on the public barrel.
import {
  computeAggregateHash,
  hashCanonicalJson,
  sha256HexBytes,
} from "../../src/plugin-bundle/hashes.js";
import {
  MCP_JSON_DIRECT,
  SKILL_MD,
  bundle,
  encode,
  manifestJson,
  minimalBundle,
} from "./fixtures.js";

function combinedBundle(overrides: Record<string, string> = {}) {
  return minimalBundle({
    "skills/demo-skill/SKILL.md": SKILL_MD,
    "skills/demo-skill/references/guide.md": "# Guide",
    ".mcp.json": MCP_JSON_DIRECT,
    ...overrides,
  });
}

describe("plugin bundle hashing", () => {
  it("is deterministic: the same input parsed twice yields identical hashes", async () => {
    const first = await parsePluginBundle(combinedBundle());
    const second = await parsePluginBundle(combinedBundle());
    expect(second.bundleHash).toBe(first.bundleHash);
    expect(second.manifestHash).toBe(first.manifestHash);
    expect(second.skills[0].contentHash).toBe(first.skills[0].contentHash);
    expect(second.skills[0].aggregateHash).toBe(first.skills[0].aggregateHash);
    expect(second.mcpServers[0].configHash).toBe(
      first.mcpServers[0].configHash
    );
  });

  it("changes the bundle hash when a single byte changes", async () => {
    const original = await parsePluginBundle(combinedBundle());
    const mutated = await parsePluginBundle(
      combinedBundle({
        "skills/demo-skill/references/guide.md": "# Guide!",
      })
    );
    expect(mutated.bundleHash).not.toBe(original.bundleHash);
    // Manifest untouched — its hash stays stable.
    expect(mutated.manifestHash).toBe(original.manifestHash);
    // The changed file is inside the skill directory: aggregate hash moves.
    expect(mutated.skills[0].aggregateHash).not.toBe(
      original.skills[0].aggregateHash
    );
    // SKILL.md itself untouched.
    expect(mutated.skills[0].contentHash).toBe(original.skills[0].contentHash);
  });

  it("changes the bundle hash when a path changes (same content)", async () => {
    const original = await parsePluginBundle(combinedBundle());
    const renamed = await parsePluginBundle(
      minimalBundle({
        "skills/demo-skill/SKILL.md": SKILL_MD,
        "skills/demo-skill/references/guide-v2.md": "# Guide",
        ".mcp.json": MCP_JSON_DIRECT,
      })
    );
    expect(renamed.bundleHash).not.toBe(original.bundleHash);
  });

  it("is independent of the source listing order", async () => {
    const files: Record<string, string> = {
      ".codex-plugin/plugin.json": manifestJson(),
      "skills/demo-skill/SKILL.md": SKILL_MD,
      ".mcp.json": MCP_JSON_DIRECT,
    };
    const forward = bundle(files, {
      entries: Object.entries(files).map(([path, content]) => ({
        path,
        size: encode(content).byteLength,
      })),
    });
    const reversed = bundle(files, {
      entries: Object.entries(files)
        .reverse()
        .map(([path, content]) => ({
          path,
          size: encode(content).byteLength,
        })),
    });
    const a = await parsePluginBundle(forward);
    const b = await parsePluginBundle(reversed);
    expect(b.bundleHash).toBe(a.bundleHash);
  });
});

describe("hash primitives", () => {
  it("sha256HexBytes matches known SHA-256 vectors", async () => {
    expect(await sha256HexBytes(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(await sha256HexBytes(encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  it("hashCanonicalJson is key-order independent", async () => {
    const a = await hashCanonicalJson({ x: 1, y: { b: 2, a: 3 } });
    const b = await hashCanonicalJson({ y: { a: 3, b: 2 }, x: 1 });
    expect(b).toBe(a);
  });

  it("computeAggregateHash is order independent but path and content sensitive", async () => {
    const base = [
      { path: "a.txt", contentHash: "11".repeat(32) },
      { path: "b.txt", contentHash: "22".repeat(32) },
    ];
    const shuffled = [base[1], base[0]];
    expect(await computeAggregateHash(shuffled)).toBe(
      await computeAggregateHash(base)
    );
    expect(
      await computeAggregateHash([
        { ...base[0], contentHash: "33".repeat(32) },
        base[1],
      ])
    ).not.toBe(await computeAggregateHash(base));
    expect(
      await computeAggregateHash([{ ...base[0], path: "a2.txt" }, base[1]])
    ).not.toBe(await computeAggregateHash(base));
  });
});
