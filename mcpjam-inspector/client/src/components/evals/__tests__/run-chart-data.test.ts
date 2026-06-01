import { describe, expect, it } from "vitest";
import type { EvalIteration } from "../types";
import type { RunCaseGroup } from "../run-case-groups";
import {
  buildDurationChartData,
  buildTokensChartData,
  tokensChartDatumTotal,
} from "../run-chart-data";

function makeIteration(
  overrides: Partial<EvalIteration> & Pick<EvalIteration, "_id">,
): EvalIteration {
  return {
    _id: overrides._id,
    createdBy: "user",
    createdAt: 0,
    iterationNumber: 1,
    updatedAt: 1000,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 0,
    ...overrides,
  };
}

function makeGroup(overrides: Partial<RunCaseGroup> & Pick<RunCaseGroup, "title">): RunCaseGroup {
  return {
    key: overrides.title,
    testCaseId: null,
    title: overrides.title,
    model: "gpt-4",
    iterations: [],
    passed: 1,
    failed: 0,
    pending: 0,
    cancelled: 0,
    total: 1,
    p50Ms: null,
    p95Ms: null,
    iterationResults: ["pass"],
    ...overrides,
  };
}

describe("buildDurationChartData", () => {
  it("maps p50 and p95 tail seconds per test group", () => {
    const data = buildDurationChartData([
      makeGroup({
        title: "Login flow",
        p50Ms: 1000,
        p95Ms: 3000,
      }),
    ]);
    expect(data).toEqual([
      {
        name: "Login flow",
        p50Ms: 1000,
        p95Ms: 3000,
        p50Seconds: 1,
        p95TailSeconds: 2,
      },
    ]);
  });
});

describe("buildTokensChartData", () => {
  it("computes stacked p50/p95 input and output per test", () => {
    const iterations = [
      makeIteration({
        _id: "a",
        metadata: { inputTokens: 100, outputTokens: 200 },
        tokensUsed: 300,
      }),
      makeIteration({
        _id: "b",
        metadata: { inputTokens: 300, outputTokens: 400 },
        tokensUsed: 700,
      }),
    ];
    const data = buildTokensChartData([
      makeGroup({ title: "Case A", iterations, p50Ms: 0, p95Ms: 0 }),
    ]);
    expect(data[0].name).toBe("Case A");
    expect(data[0].inputP50).toBe(200);
    expect(data[0].outputP50).toBe(300);
    expect(data[0].inputP95Tail).toBe(90);
    expect(data[0].outputP95Tail).toBe(90);
    expect(tokensChartDatumTotal(data[0])).toBe(680);
  });

  it("falls back to tokensUsed as output when metadata is missing", () => {
    const data = buildTokensChartData([
      makeGroup({
        title: "Legacy",
        iterations: [
          makeIteration({ _id: "x", tokensUsed: 42, result: "passed" }),
        ],
      }),
    ]);
    expect(data[0].inputP50).toBe(0);
    expect(data[0].outputP50).toBe(42);
    expect(data[0].inputP95Tail).toBe(0);
    expect(data[0].outputP95Tail).toBe(0);
  });
});
