import { describe, expect, it } from "vitest";
import { buildIterationUsageMetadata } from "../iteration-usage-metadata";

describe("buildIterationUsageMetadata", () => {
  it("persists input and output token counts", () => {
    expect(
      buildIterationUsageMetadata({
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
      }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 80,
    });
  });

  it("infers input from total when only output is reported", () => {
    expect(
      buildIterationUsageMetadata({
        outputTokens: 80,
        totalTokens: 200,
      }),
    ).toEqual({
      outputTokens: 80,
      inputTokens: 120,
    });
  });

  it("omits undefined usage fields", () => {
    expect(buildIterationUsageMetadata({ totalTokens: 10 })).toEqual({});
  });

  it("persists prompt-cache breakdown when present", () => {
    expect(
      buildIterationUsageMetadata({
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        cachedInputTokens: 60,
        cacheWriteTokens: 10,
        noCacheInputTokens: 30,
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 60,
      cacheWriteTokens: 10,
      noCacheInputTokens: 30,
    });
  });

  it("omits cache fields when absent (cache-free iteration)", () => {
    expect(
      buildIterationUsageMetadata({
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      }),
    ).toEqual({ inputTokens: 100, outputTokens: 40 });
  });
});
