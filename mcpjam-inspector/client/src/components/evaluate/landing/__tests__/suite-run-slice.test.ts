import { describe, expect, it } from "vitest";
import {
  buildSuiteRunSlice,
  suiteTrend,
  type SuiteSlicePoint,
  type SuiteSliceRun,
} from "../suite-run-slice";

function run(
  runNumber: number,
  passRate: number,
  overrides: Partial<SuiteSliceRun> = {},
): SuiteSliceRun {
  return {
    _id: `r_${runNumber}`,
    runNumber,
    status: "completed",
    result: passRate >= 0.8 ? "passed" : "failed",
    summary: {
      total: 10,
      passed: passRate * 10,
      failed: 10 - passRate * 10,
      passRate,
    },
    createdAt: runNumber * 1000,
    completedAt: runNumber * 1000 + 500,
    ...overrides,
  };
}

function points(...verdicts: Array<[number, boolean]>): SuiteSlicePoint[] {
  return verdicts.map(([rate, passed], i) => ({
    runId: `r_${i}`,
    runNumber: i + 1,
    rate,
    passed,
    completedAt: i,
  }));
}

describe("buildSuiteRunSlice", () => {
  it("keeps the five newest finished runs, oldest first", () => {
    const recentRuns = [7, 6, 5, 4, 3, 2, 1].map((n) => run(n, 1));
    const slice = buildSuiteRunSlice({ recentRuns });
    expect(slice.points.map((p) => p.runNumber)).toEqual([3, 4, 5, 6, 7]);
    expect(slice.latest?.runNumber).toBe(7);
    expect(slice.latest?.completedAt).toBe(7500);
  });

  it("leaves out runs in flight, subset reruns and inconclusive runs", () => {
    const slice = buildSuiteRunSlice({
      recentRuns: [
        run(5, 1, { status: "running" }),
        run(4, 0.5, { rerunScope: "failed_cases" }),
        run(3, 0, { result: "inconclusive" }),
        run(2, 0.9, { summary: undefined }),
        run(1, 0.6),
      ],
    });
    expect(slice.points.map((p) => p.runNumber)).toEqual([1]);
    expect(slice.average).toBe(60);
    expect(slice.trend).toEqual({ kind: "single" });
  });

  it("averages the slice's pass rates", () => {
    const slice = buildSuiteRunSlice({ recentRuns: [run(2, 1), run(1, 0.5)] });
    expect(slice.average).toBe(75);
    expect(slice.points.map((p) => p.passed)).toEqual([false, true]);
  });

  it("has no average or trend before a run finishes", () => {
    expect(buildSuiteRunSlice({ recentRuns: [] })).toEqual({
      points: [],
      average: null,
      latest: null,
      trend: null,
    });
  });
});

describe("suiteTrend", () => {
  it.each([
    [points([80, true]), { kind: "single" }],
    [
      points([90, true], [40, false], [90, true], [40, false]),
      { kind: "flaky", passed: 2, runs: 4 },
    ],
    [points([90, true], [91, true], [92, true]), { kind: "steady", runs: 3 }],
    [
      points([40, false], [60, false], [90, true]),
      { kind: "up", points: 50, runs: 3 },
    ],
    [points([100, true], [70, false]), { kind: "down", points: 30, runs: 2 }],
  ])("reads %o as %o", (slice, expected) => {
    expect(suiteTrend(slice)).toEqual(expected);
  });
});
