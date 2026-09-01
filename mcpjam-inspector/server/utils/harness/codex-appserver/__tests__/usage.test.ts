/**
 * Token accounting. This feeds billing telemetry, so the arithmetic is pinned
 * rather than eyeballed.
 */
import { describe, expect, it } from "vitest";
import { toHarnessUsage, zeroUsage } from "../bridge/usage.js";

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
