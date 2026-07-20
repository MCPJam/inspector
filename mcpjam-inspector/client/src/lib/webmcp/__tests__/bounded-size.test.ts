import { describe, expect, it } from "vitest";
import { boundedJsonByteLength } from "../bounded-size";

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
