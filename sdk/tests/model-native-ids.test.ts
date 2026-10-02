/**
 * The reviewed canonical ↔ native model id table.
 *
 * Mapping is lookup, never string surgery: the dotted canonical and the dashed
 * native id differ by more than a prefix, and an id the table does not know is
 * passed through rather than guessed at.
 */
import {
  ANTHROPIC_NATIVE_MODEL_IDS,
  anthropicNativeModelId,
} from "../src/model-native-ids.js";
import * as modelFactory from "../src/model-factory.js";

describe("anthropicNativeModelId", () => {
  it.each([
    ["claude-sonnet-4.5", "claude-sonnet-4-5"],
    ["claude-haiku-4.5", "claude-haiku-4-5"],
    ["claude-opus-4.8", "claude-opus-4-8"],
    ["claude-sonnet-4.6", "claude-sonnet-4-6"],
    // Same spelling on both sides: still a reviewed row, still mapped.
    ["claude-fable-5", "claude-fable-5"],
  ])("maps the canonical %s to %s", (canonical, native) => {
    expect(anthropicNativeModelId(canonical)).toBe(native);
  });

  it.each([
    // Native ids and dated snapshots are already what the API takes.
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5-20251001",
    // Unknown ids are the caller's to choose.
    "claude-3-5-sonnet-20241022",
    "claude-opus-9",
    // Shaped like a mapped id, but not reviewed: not derived.
    "claude-sonnet-9.9",
  ])("passes %s through unchanged", (id) => {
    expect(anthropicNativeModelId(id)).toBe(id);
  });

  it("looks up the canonical spelling without the vendor prefix", () => {
    // The factory hands over the MODEL part of `anthropic/<model>`; a caller
    // that passes the whole canonical id gets it back untouched rather than a
    // half-mapped string.
    expect(anthropicNativeModelId("anthropic/claude-sonnet-4.5")).toBe(
      "anthropic/claude-sonnet-4.5"
    );
  });
});

describe("ANTHROPIC_NATIVE_MODEL_IDS", () => {
  it("is well-formed: evidence on every row, no duplicate or shared ids", () => {
    const canonical = new Set<string>();
    const native = new Map<string, string>();
    for (const row of ANTHROPIC_NATIVE_MODEL_IDS) {
      expect(row.canonicalId.startsWith("anthropic/")).toBe(true);
      expect(row.evidence.length).toBeGreaterThan(20);
      expect(canonical.has(row.canonicalId)).toBe(false);
      canonical.add(row.canonicalId);
      for (const id of [row.nativeId, ...(row.nativeAliases ?? [])]) {
        expect(native.get(id) ?? row.canonicalId).toBe(row.canonicalId);
        native.set(id, row.canonicalId);
      }
    }
  });

  it("maps every row's canonical id to that row's native id", () => {
    for (const row of ANTHROPIC_NATIVE_MODEL_IDS) {
      expect(
        anthropicNativeModelId(row.canonicalId.slice("anthropic/".length))
      ).toBe(row.nativeId);
    }
  });

  it("is frozen, so a consumer cannot edit the shared rows in place", () => {
    expect(Object.isFrozen(ANTHROPIC_NATIVE_MODEL_IDS)).toBe(true);
  });

  it("is the same table through the `@mcpjam/sdk/model-factory` entry", () => {
    // The Inspector server's BYOK adapter reads it from there; a copy would
    // be a second table to drift.
    expect(modelFactory.ANTHROPIC_NATIVE_MODEL_IDS).toBe(
      ANTHROPIC_NATIVE_MODEL_IDS
    );
    expect(modelFactory.anthropicNativeModelId).toBe(anthropicNativeModelId);
  });
});
