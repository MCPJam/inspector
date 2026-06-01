import { describe, expect, it } from "vitest";
import {
  hasRecordedTokenBreakdown,
  readIterationTokenBreakdown,
} from "../iteration-token-usage";
import type { EvalIteration } from "../types";

function makeIteration(
  overrides: Partial<EvalIteration> & Pick<EvalIteration, "_id">,
): EvalIteration {
  return {
    _id: overrides._id,
    createdBy: "user",
    createdAt: 0,
    iterationNumber: 1,
    updatedAt: 1,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 0,
    ...overrides,
  };
}

describe("readIterationTokenBreakdown", () => {
  it("reads input and output from metadata", () => {
    expect(
      readIterationTokenBreakdown(
        makeIteration({
          _id: "1",
          metadata: { inputTokens: 10, outputTokens: 20 },
          tokensUsed: 30,
        }),
      ),
    ).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("parses numeric strings from metadata", () => {
    expect(
      readIterationTokenBreakdown(
        makeIteration({
          _id: "1",
          metadata: { inputTokens: "100", outputTokens: "50" },
          tokensUsed: 150,
        }),
      ),
    ).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("infers input from tokensUsed when only output is stored", () => {
    expect(
      readIterationTokenBreakdown(
        makeIteration({
          _id: "2",
          metadata: { outputTokens: 400 },
          tokensUsed: 1500,
        }),
      ),
    ).toEqual({ inputTokens: 1100, outputTokens: 400 });
  });

  it("keeps zero input when total matches output only", () => {
    expect(
      readIterationTokenBreakdown(
        makeIteration({
          _id: "3",
          metadata: { inputTokens: 0, outputTokens: 99 },
          tokensUsed: 99,
        }),
      ),
    ).toEqual({ inputTokens: 0, outputTokens: 99 });
  });

  it("uses tokensUsed as output-only legacy fallback", () => {
    expect(
      readIterationTokenBreakdown(
        makeIteration({ _id: "4", tokensUsed: 99, result: "passed" }),
      ),
    ).toEqual({ inputTokens: 0, outputTokens: 99 });
  });
});

describe("hasRecordedTokenBreakdown", () => {
  it("is false for legacy total-only iterations", () => {
    expect(
      hasRecordedTokenBreakdown(
        makeIteration({ _id: "5", tokensUsed: 99, result: "passed" }),
      ),
    ).toBe(false);
  });

  it("is true when metadata includes input tokens", () => {
    expect(
      hasRecordedTokenBreakdown(
        makeIteration({
          _id: "6",
          metadata: { inputTokens: 1, outputTokens: 2 },
          tokensUsed: 3,
        }),
      ),
    ).toBe(true);
  });
});
