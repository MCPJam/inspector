import { describe, expect, it } from "vitest";
import {
  boundedJsonByteLength,
  boundedJsonString,
  MAX_RESULT_CHARS,
} from "../bounded-size";

describe("boundedJsonByteLength", () => {
  it("reports an approximate size for a small value without truncating", () => {
    const { bytes, truncated } = boundedJsonByteLength({ a: "hello", n: 1 });
    expect(truncated).toBe(false);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(64 * 1024);
  });

  it("truncates on a large SCALAR payload (byte cap)", () => {
    const big = "x".repeat(200_000);
    const { truncated } = boundedJsonByteLength(big, 64 * 1024);
    expect(truncated).toBe(true);
  });

  it("truncates on a NODE-heavy shape that carries almost no scalar bytes", () => {
    // Millions of nulls: near-zero scalar bytes, but a scalar-only cap would
    // let JSON.stringify walk every node and block the thread. The node budget
    // must abort this.
    const nodeHeavy = new Array(500_000).fill(null);
    const { truncated } = boundedJsonByteLength(nodeHeavy, 64 * 1024);
    expect(truncated).toBe(true);
  });

  it("respects a custom node budget", () => {
    const arr = new Array(1_000).fill(null);
    expect(boundedJsonByteLength(arr, 64 * 1024, 100).truncated).toBe(true);
    expect(boundedJsonByteLength(arr, 64 * 1024, 10_000).truncated).toBe(false);
  });

  it("returns a finite, non-throwing result for a cyclic structure", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    // JSON.stringify throws on cycles; the helper must swallow that, not crash.
    expect(() => boundedJsonByteLength(cyclic)).not.toThrow();
  });
});

describe("boundedJsonString", () => {
  it("returns a small value unchanged, and parses", () => {
    const text = boundedJsonString({ a: "hello", n: 1, flag: true });
    expect(text).not.toBeNull();
    expect(JSON.parse(text!)).toEqual({ a: "hello", n: 1, flag: true });
  });

  it("refuses a value whose OUTPUT exceeds the cap, even with no scalar bytes", () => {
    // The hole a payload-only budget leaves: 100,000 `null`s carry nothing a
    // scalar counter would see, sit inside the node budget, and serialize to
    // roughly half a megabyte. Whatever this returns, it is never over the
    // cap it was given.
    const nullHeavy = new Array(100_000).fill(null);
    expect(boundedJsonString(nullHeavy)).toBeNull();
    expect(JSON.stringify(nullHeavy).length).toBeGreaterThan(MAX_RESULT_CHARS);
  });

  it("counts property names, which are output too", () => {
    // 400 keys of 200 characters: 80 KB of pure key, and not one byte of it
    // is a value.
    const wideKeys = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`${"k".repeat(200)}${i}`, 0]),
    );
    expect(boundedJsonString(wideKeys)).toBeNull();
  });

  it("truncates one oversized string rather than giving up on the value", () => {
    // A single huge scalar is one node: the node budget cannot catch it, so
    // the replacer cuts it to what is left of the cap.
    const text = boundedJsonString({ body: "x".repeat(MAX_RESULT_CHARS * 4) });
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(JSON.parse(text!).body).toMatch(/x+…$/);
  });

  it("never returns more than the cap, whatever the shape", () => {
    const cap = 256;
    const shapes: unknown[] = [
      new Array(5_000).fill(null),
      new Array(5_000).fill({}),
      Array.from({ length: 200 }, (_, i) => ({ [`key${i}`]: i })),
      { nested: { deep: { deeper: "y".repeat(5_000) } } },
      '"'.repeat(5_000),
      Array.from({ length: 500 }, (_, i) => 1e300 + i),
    ];
    for (const shape of shapes) {
      const text = boundedJsonString(shape, cap);
      if (text !== null) expect(text.length).toBeLessThanOrEqual(cap);
    }
  });

  it("returns null for what cannot be serialized at all", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(boundedJsonString(cyclic)).toBeNull();
    expect(boundedJsonString(undefined)).toBeNull();
  });
});
