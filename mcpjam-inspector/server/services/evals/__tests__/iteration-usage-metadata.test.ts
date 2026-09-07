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

describe("buildIterationUsagePayload — an unmeasured trial", () => {
  it("withholds an all-zero split rather than letting it be priced as free", () => {
    // A runner that reported nothing arrives as all zeros. Forwarding that
    // split is not harmless: the backend accepts any numeric token field as
    // a signal, prices 0 input and 0 output, and stamps
    // `estimatedCostUsd: 0` with `status: "estimated"` — a confident claim
    // that a trial nobody measured cost nothing.
    expect(
      buildIterationUsagePayload({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
    ).toBeUndefined();
    expect(buildIterationUsagePayload({})).toBeUndefined();
  });

  it("keeps a zero half when the other half is real", () => {
    // "0 output tokens" is a genuine reading alongside 500 input tokens, and
    // dropping it would understate the input the trial actually paid for.
    expect(
      buildIterationUsagePayload({ inputTokens: 500, outputTokens: 0 }),
    ).toEqual({ inputTokens: 500, outputTokens: 0 });
  });
});
