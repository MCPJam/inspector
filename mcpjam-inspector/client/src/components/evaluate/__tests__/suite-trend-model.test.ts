import { describe, expect, it } from "vitest";
import type { EvalSuiteOverviewEntry, EvalSuiteRun } from "../../evals/types";
import {
  buildSuiteTrend,
  latestRunLabel,
  trendWord,
  type SuiteTrendBar,
} from "../suite-trend-model";

function run(
  runNumber: number,
  rate: number,
  overrides: Partial<EvalSuiteRun> = {},
): EvalSuiteRun {
  return {
    _id: `run-${runNumber}`,
    suiteId: "suite-1",
    createdBy: "user-1",
    runNumber,
    configRevision: "rev",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: rate >= 1 ? "passed" : "failed",
    summary: {
      total: 10,
      passed: rate * 10,
      failed: 10 - rate * 10,
      passRate: rate,
    },
    createdAt: runNumber * 1000,
    completedAt: runNumber * 1000 + 1,
    ...overrides,
  } as EvalSuiteRun;
}

/** Runs listed oldest first, as a reader thinks of them. */
function entry(runs: EvalSuiteRun[]): EvalSuiteOverviewEntry {
  const newestFirst = [...runs].reverse();
  return {
    suite: { _id: "suite-1", name: "Suite" } as EvalSuiteOverviewEntry["suite"],
    latestRun: newestFirst[0] ?? null,
    recentRuns: newestFirst,
    passRateTrend: [],
    totals: { passed: 0, failed: 0, runs: runs.length },
  };
}

const bar = (passed: boolean, rate: number, runNumber = 1): SuiteTrendBar => ({
  runId: `run-${runNumber}`,
  runNumber,
  rate,
  passed,
});

describe("buildSuiteTrend", () => {
  it("averages every measured run and draws the last five, oldest first", () => {
    const trend = buildSuiteTrend(
      entry([
        run(1, 1),
        run(2, 0.5),
        run(3, 1),
        run(4, 0.5),
        run(5, 1),
        run(6, 0.5),
      ]),
    );
    expect(trend.average).toBe(75);
    expect(trend.averagedRuns).toBe(6);
    expect(trend.bars.map((b) => b.runNumber)).toEqual([2, 3, 4, 5, 6]);
    expect(trend.word).toEqual({ kind: "flaky", passed: 2, total: 5 });
  });

  it("leaves out active, inconclusive, failed-only reruns and empty runs", () => {
    const trend = buildSuiteTrend(
      entry([
        run(1, 1),
        run(2, 0.2, { rerunScope: "failed_cases" }),
        run(3, 0, { result: "inconclusive" }),
        run(4, 0, { summary: { total: 0, passed: 0, failed: 0, passRate: 0 } }),
        run(5, 0, { status: "running", result: "pending" }),
        run(6, 0.6),
      ]),
    );
    expect(trend.bars.map((b) => b.runNumber)).toEqual([1, 6]);
    expect(trend.average).toBe(80);
  });

  it("has no average or word before a run finishes", () => {
    expect(buildSuiteTrend(entry([]))).toEqual({
      average: null,
      averagedRuns: 0,
      bars: [],
      word: null,
    });
  });

  it("judges a legacy run with no verdict by its own pass bar", () => {
    const trend = buildSuiteTrend(
      entry([
        run(1, 0.8, {
          result: undefined,
          passCriteria: { minimumPassRate: 70 },
        }),
        run(2, 0.6, {
          result: undefined,
          passCriteria: { minimumPassRate: 70 },
        }),
      ]),
    );
    expect(trend.bars.map((b) => b.passed)).toEqual([true, false]);
  });
});

describe("trendWord", () => {
  it("needs two runs", () => {
    expect(trendWord([bar(true, 100)])).toBeNull();
  });

  it("calls two or more flips Flaky", () => {
    expect(trendWord([bar(false, 40), bar(true, 100), bar(false, 40)])).toEqual(
      { kind: "flaky", passed: 1, total: 3 },
    );
  });

  it("reads a rise or fall of ten points or more as Up or Down", () => {
    expect(
      trendWord([
        bar(false, 50),
        bar(false, 60),
        bar(true, 100),
        bar(true, 100),
      ]),
    ).toEqual({ kind: "up", points: 50, runs: 4 });
    expect(trendWord([bar(true, 100), bar(false, 33)])).toEqual({
      kind: "down",
      points: 67,
      runs: 2,
    });
  });

  it("reads a smaller change as Steady", () => {
    expect(trendWord([bar(true, 100), bar(true, 95)])).toEqual({
      kind: "steady",
      runs: 2,
    });
  });
});

describe("latestRunLabel", () => {
  it("names the run, its verdict and rate", () => {
    expect(latestRunLabel(run(6, 2 / 3))).toEqual({
      runNumber: 6,
      verdict: "Failed 67%",
      tone: "destructive",
    });
    expect(latestRunLabel(run(9, 1))).toEqual({
      runNumber: 9,
      verdict: "Passed 100%",
      tone: "success",
    });
  });

  it("says Running for a run in flight and nothing without a run", () => {
    expect(
      latestRunLabel(run(3, 0, { status: "running", result: "pending" }))
        ?.verdict,
    ).toBe("Running");
    expect(latestRunLabel(null)).toBeNull();
  });

  it("keeps inconclusive and cancelled runs out of pass and fail", () => {
    expect(latestRunLabel(run(2, 0, { result: "inconclusive" }))?.tone).toBe(
      "muted",
    );
    expect(
      latestRunLabel(run(2, 0, { status: "cancelled", result: "cancelled" }))
        ?.verdict,
    ).toBe("Cancelled");
  });
});
