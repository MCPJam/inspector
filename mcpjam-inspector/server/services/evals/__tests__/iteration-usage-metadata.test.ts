import { describe, expect, it } from "vitest";
import {
  buildIterationUsageMetadata,
  buildIterationUsagePayload,
} from "../iteration-usage-metadata";
import { addUsageTotals, copyUsageTotals, type UsageTotals } from "../types";

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

  it("carries the reasoning and cached-input breakdown when reported", () => {
    expect(
      buildIterationUsagePayload({
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
        reasoningTokens: 50,
        cachedInputTokens: 0,
      }),
    ).toEqual({
      inputTokens: 120,
      outputTokens: 80,
      totalTokens: 200,
      reasoningTokens: 50,
      cachedInputTokens: 0,
    });
  });

  it("does not send a breakdown on an unmeasured trial", () => {
    expect(
      buildIterationUsagePayload({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        reasoningTokens: 0,
      }),
    ).toBeUndefined();
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

describe("buildIterationUsageMetadata — a reported zero half", () => {
  it("reconciles the missing half when the known one is zero", () => {
    // `{ inputTokens: 0, totalTokens: 100 }` is a complete statement: no
    // input, 100 output. Requiring the known half to be POSITIVE refused to
    // read it, and the backend — which prices from the halves alone — then
    // stamped a 100-token turn as `estimated` at $0.00.
    expect(
      buildIterationUsageMetadata({ inputTokens: 0, totalTokens: 100 }),
    ).toEqual({ inputTokens: 0, outputTokens: 100 });
    expect(
      buildIterationUsageMetadata({ outputTokens: 0, totalTokens: 100 }),
    ).toEqual({ outputTokens: 0, inputTokens: 100 });
  });

  it("still refuses to invent a split from a bare total", () => {
    // Neither half reported: there is no allocation to infer, and the backend
    // answers `not_reported` rather than pricing a guess.
    expect(buildIterationUsageMetadata({ totalTokens: 10 })).toEqual({});
  });
});

describe("addUsageTotals / copyUsageTotals", () => {
  it("sums the totals and only the breakdown fields some turn reported", () => {
    const acc: UsageTotals = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    addUsageTotals(acc, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(acc).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect("reasoningTokens" in acc).toBe(false);

    addUsageTotals(acc, {
      inputTokens: 20,
      outputTokens: 30,
      totalTokens: 50,
      reasoningTokens: 12,
      cachedInputTokens: 4,
    });
    addUsageTotals(acc, { reasoningTokens: 3 });
    addUsageTotals(acc, undefined);
    expect(acc).toEqual({
      inputTokens: 30,
      outputTokens: 35,
      totalTokens: 65,
      reasoningTokens: 15,
      cachedInputTokens: 4,
    });
  });

  it("copies without inventing absent breakdown fields", () => {
    expect(
      Object.keys(
        copyUsageTotals({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }),
      ),
    ).toEqual(["inputTokens", "outputTokens", "totalTokens"]);
    const source = { inputTokens: 1, reasoningTokens: 7 };
    const copy = copyUsageTotals(source);
    expect(copy).toMatchObject({ inputTokens: 1, reasoningTokens: 7 });
    expect(copy).not.toBe(source);
  });
});
