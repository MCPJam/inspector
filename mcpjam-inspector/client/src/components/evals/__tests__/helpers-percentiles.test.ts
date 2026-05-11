import { describe, it, expect } from "vitest";
import {
  iterationLatencyP50,
  iterationLatencyP95,
  iterationTokensP50,
  iterationTokensP95,
  percentile,
} from "../helpers";
import type { EvalIteration } from "../types";

function makeIteration(
  overrides: Partial<EvalIteration> & {
    startedAt: number;
    updatedAt: number;
    tokensUsed?: number;
  },
): EvalIteration {
  return {
    _id: `it-${Math.random().toString(36).slice(2)}`,
    testCaseId: "tc-1",
    projectId: "p-1",
    testCaseSnapshot: {
      title: "t",
      query: "q",
      models: [],
      expectedToolCalls: [],
    } as unknown as EvalIteration["testCaseSnapshot"],
    suiteRunId: "sr-1",
    createdBy: "u-1",
    createdAt: overrides.startedAt,
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 0,
    ...overrides,
  } as EvalIteration;
}

describe("percentile", () => {
  it("returns null for empty input", () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it("returns min/max for p=0 and p=1", () => {
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
  });

  it("computes p50 of a 4-element series", () => {
    // rank = 3 * 0.5 = 1.5 -> interpolate between 2 and 3 -> 2.5
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it("computes p95 of a 20-element series with linear interpolation", () => {
    const vals = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    // rank = 19 * 0.95 = 18.05 -> between 19 and 20 -> 19.05
    const p = percentile(vals, 0.95);
    expect(p).toBeCloseTo(19.05, 5);
  });
});

describe("iteration latency percentiles", () => {
  it("returns null when there are no completed iterations", () => {
    expect(iterationLatencyP50([])).toBeNull();
    expect(iterationLatencyP95([])).toBeNull();
  });

  it("ignores running / failed iterations and computes durations", () => {
    const items: EvalIteration[] = [
      makeIteration({ startedAt: 0, updatedAt: 100 }),
      makeIteration({ startedAt: 0, updatedAt: 200 }),
      makeIteration({ startedAt: 0, updatedAt: 300 }),
      makeIteration({
        startedAt: 0,
        updatedAt: 999999,
        status: "failed",
      }),
    ];
    expect(iterationLatencyP50(items)).toBe(200);
  });

  it("ignores iterations missing startedAt", () => {
    const items: EvalIteration[] = [
      makeIteration({ startedAt: 0, updatedAt: 100 }),
      makeIteration({ startedAt: undefined as unknown as number, updatedAt: 100 }),
      makeIteration({ startedAt: 0, updatedAt: 500 }),
    ];
    expect(iterationLatencyP50(items)).toBe(300);
  });
});

describe("iteration token percentiles", () => {
  it("computes p50 and p95 of tokensUsed", () => {
    const items: EvalIteration[] = [10, 20, 30, 40, 50].map((tokens) =>
      makeIteration({ startedAt: 0, updatedAt: 1, tokensUsed: tokens }),
    );
    expect(iterationTokensP50(items)).toBe(30);
    expect(iterationTokensP95(items)).toBeCloseTo(48, 5);
  });
});
