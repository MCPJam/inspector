/**
 * Token accounting. This feeds billing telemetry, so the arithmetic is pinned
 * rather than eyeballed.
 */
import { describe, expect, it } from "vitest";
import {
  addBreakdowns,
  diffUsage,
  toHarnessUsage,
  zeroUsage,
} from "../bridge/usage.js";

describe("toHarnessUsage", () => {
  it("splits input into a non-overlapping breakdown", () => {
    // The components must not overlap: `@ai-sdk/harness-claude-code` maps
    // Anthropic's disjoint triple straight across and reports `total` as their
    // SUM, so a consumer that adds them expects no double counting.
    const usage = toHarnessUsage({
      inputTokens: 1000,
      cachedInputTokens: 600,
      cacheWriteInputTokens: 150,
      outputTokens: 100,
      reasoningOutputTokens: 40,
      totalTokens: 1100,
    });
    expect(usage.inputTokens).toEqual({
      total: 1000,
      noCache: 250,
      cacheRead: 600,
      cacheWrite: 150,
    });
    const { noCache = 0, cacheRead = 0, cacheWrite = 0 } = usage.inputTokens;
    expect(noCache + cacheRead + cacheWrite).toBe(usage.inputTokens.total);
  });

  it("matches the published Codex adapter when no cache write is reported", () => {
    // Every capture so far reports `cacheWriteInputTokens: 0`, which is exactly
    // why the overlap above went unnoticed. This is the shape that is actually
    // observed today, and it must be unchanged by the subtraction.
    const usage = toHarnessUsage({
      inputTokens: 1200,
      cachedInputTokens: 1024,
      cacheWriteInputTokens: 0,
      outputTokens: 96,
      reasoningOutputTokens: 64,
      totalTokens: 1296,
    });
    expect(usage.inputTokens.noCache).toBe(176);
    expect(usage.outputTokens).toEqual({ total: 96, text: 32, reasoning: 64 });
  });

  it("never reports a negative component", () => {
    // A provider that reports more cached tokens than input tokens is wrong,
    // but a negative token count propagating into billing is worse.
    const usage = toHarnessUsage({
      inputTokens: 10,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 30,
      outputTokens: 5,
      reasoningOutputTokens: 90,
      totalTokens: 15,
    });
    expect(usage.inputTokens.noCache).toBe(0);
    expect(usage.outputTokens.text).toBe(0);
  });

  it("reports zeroes for an absent breakdown", () => {
    expect(toHarnessUsage(undefined)).toEqual(zeroUsage());
  });
});

describe("diffUsage", () => {
  const at = (total: number, input: number, output: number) => ({
    totalTokens: total,
    inputTokens: input,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: 0,
  });

  it("reports the delta between two cumulative snapshots", () => {
    const usage = diffUsage(at(300, 200, 100), at(100, 80, 20));
    expect(usage?.inputTokens.total).toBe(120);
    expect(usage?.outputTokens.total).toBe(80);
  });

  it("treats an absent start as the whole of the end", () => {
    const usage = diffUsage(at(300, 200, 100), undefined);
    expect(usage?.inputTokens.total).toBe(200);
  });

  it("gives up on a DECREASING counter rather than reporting nonsense", () => {
    // Cumulative totals go DOWN across a compaction, because the context they
    // count was rewritten. A negative delta is not a small number, it is a
    // wrong one — `undefined` is the signal to fall back to per-request
    // accounting instead of billing a negative turn.
    expect(diffUsage(at(100, 80, 20), at(300, 200, 100))).toBeUndefined();
  });

  it("reports nothing when there is no end snapshot", () => {
    expect(diffUsage(undefined, at(100, 80, 20))).toBeUndefined();
  });
});

describe("addBreakdowns", () => {
  it("sums component-wise", () => {
    const sum = addBreakdowns(
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    );
    expect(sum.inputTokens).toBe(11);
    expect(sum.outputTokens).toBe(7);
    expect(sum.totalTokens).toBe(18);
  });

  it("keeps a component undefined only when BOTH sides are", () => {
    // The distinction that matters: "not reported" must not silently become 0,
    // because 0 is a claim and absence is not.
    const sum = addBreakdowns(
      { inputTokens: 10 },
      { outputTokens: 4 },
    );
    expect(sum.inputTokens).toBe(10);
    expect(sum.outputTokens).toBe(4);
    expect(sum.cachedInputTokens).toBeUndefined();
  });

  it("returns the first operand unchanged when the second is absent", () => {
    const a = { inputTokens: 10, outputTokens: 5 };
    expect(addBreakdowns(a, undefined)).toBe(a);
  });
});
