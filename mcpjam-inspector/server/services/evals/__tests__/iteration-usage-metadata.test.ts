import { describe, expect, it } from "vitest";
import {
  buildIterationUsageMetadata,
  buildIterationUsagePayload,
} from "../iteration-usage-metadata";

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
});

describe("buildIterationUsagePayload", () => {
  it("carries the reconciled split plus the total", () => {
    expect(
      buildIterationUsagePayload({
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
      }),
    ).toEqual({ inputTokens: 120, outputTokens: 80, totalTokens: 200 });
  });

  it("uses the same back-filled half the metadata bag reports", () => {
    // A cost priced off `usage` and a chart drawn off `metadata` must never
    // disagree, so both derive from one reconciliation.
    const usage = { outputTokens: 80, totalTokens: 200 };
    const payload = buildIterationUsagePayload(usage);
    expect(payload).toEqual({
      inputTokens: 120,
      outputTokens: 80,
      totalTokens: 200,
    });
    expect(buildIterationUsageMetadata(usage)).toMatchObject({
      inputTokens: payload!.inputTokens!,
      outputTokens: payload!.outputTokens!,
    });
  });

  it("returns undefined when there is no token signal at all", () => {
    expect(buildIterationUsagePayload({})).toBeUndefined();
    expect(buildIterationUsagePayload({ totalTokens: 0 })).toBeUndefined();
  });

  it("keeps a partial split when no total is reported", () => {
    expect(buildIterationUsagePayload({ inputTokens: 42 })).toEqual({
      inputTokens: 42,
    });
  });
});
