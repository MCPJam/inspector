import { describe, expect, it } from "vitest";
import { mergeLiveChatTraceUsage } from "../live-chat-trace";

describe("mergeLiveChatTraceUsage", () => {
  it("returns undefined when both sides are undefined", () => {
    expect(mergeLiveChatTraceUsage(undefined, undefined)).toBeUndefined();
  });

  it("sums the base token fields", () => {
    expect(
      mergeLiveChatTraceUsage(
        { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      ),
    ).toEqual({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
  });

  it("carries non-cached input tokens (never derived from the total)", () => {
    const merged = mergeLiveChatTraceUsage(
      { inputTokens: 100, cachedInputTokens: 30, cacheWriteTokens: 10 },
      undefined,
    );
    // The provider's own noCache figure only appears when carried; it is
    // NOT synthesized from inputTokens - cacheRead (which would ignore
    // writes). Absent here because the base carried none.
    expect(Object.keys(merged ?? {})).not.toContain("noCacheInputTokens");

    const withNoCache = mergeLiveChatTraceUsage(
      { inputTokens: 100, noCacheInputTokens: 60 },
      { inputTokens: 100, noCacheInputTokens: 55 },
    );
    expect(withNoCache).toMatchObject({ noCacheInputTokens: 115 });
  });

  it("sums cache-read/write tokens when present on both sides", () => {
    expect(
      mergeLiveChatTraceUsage(
        {
          inputTokens: 5,
          totalTokens: 5,
          cachedInputTokens: 3,
          cacheWriteTokens: 1,
        },
        {
          inputTokens: 7,
          totalTokens: 7,
          cachedInputTokens: 4,
          cacheWriteTokens: 2,
        },
      ),
    ).toEqual({
      inputTokens: 12,
      totalTokens: 12,
      cachedInputTokens: 7,
      cacheWriteTokens: 3,
    });
  });

  it("carries cache tokens present on only one side", () => {
    const merged = mergeLiveChatTraceUsage(
      { inputTokens: 5 },
      { inputTokens: 7, cachedInputTokens: 4 },
    );
    expect(merged).toEqual({ inputTokens: 12, cachedInputTokens: 4 });
    // Preserve-undefined convention: absent on both sides ⇒ key never appears.
    expect(Object.keys(merged ?? {})).not.toContain("cacheWriteTokens");
  });

  it("leaves cache fields out entirely when absent on both sides (no churn)", () => {
    const merged = mergeLiveChatTraceUsage(
      { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    );
    expect(Object.keys(merged ?? {}).sort()).toEqual([
      "inputTokens",
      "outputTokens",
      "totalTokens",
    ]);
  });
});
