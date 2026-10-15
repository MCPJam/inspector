import { describe, expect, it } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";
import {
  aggregateSuite,
  isSubsetRerunRun,
  pickLatestCompletedRun,
  withoutSubsetRerunIterations,
} from "../helpers";
import { SuiteHeroStats } from "../suite-hero-stats";
import { useSuiteData, useSuiteDataFromMetrics } from "../use-suite-data";
import { metricsByRunFromIterations } from "../run-metrics";
import {
  previousCompletedRunOf,
  previousLaunchRuns,
} from "../../evaluate/run-verdict-hero-deltas";
import type { EvalIteration, EvalSuite, EvalSuiteRun } from "../types";

/**
 * A subset rerun re-ran only the cases that did not pass, so its pass rate is
 * biased by that selection. It may be shown, but it is never the "latest run"
 * a number describes, a trend point, a baseline, or part of a suite aggregate
 * — counting its trials would add a second attempt to exactly the cases that
 * already failed.
 */

function run(overrides: Partial<EvalSuiteRun> & { _id: string }): EvalSuiteRun {
  return {
    suiteId: "suite",
    createdBy: "u1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "passed",
    createdAt: 1_000,
    namedHostId: "cursor",
    effectiveModelId: "gpt-5.1",
    ...overrides,
  } as EvalSuiteRun;
}

function iteration(
  id: string,
  suiteRunId: string,
  result: "passed" | "failed",
  testCaseId = "case-1",
): EvalIteration {
  return {
    _id: id,
    suiteRunId,
    testCaseId,
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 2,
    startedAt: 1,
    iterationNumber: 1,
    status: "completed",
    result,
    resultSource: "reported",
    actualToolCalls: [],
    tokensUsed: 10,
    testCaseSnapshot: {
      title: "Case",
      query: "q",
      provider: "openai",
      model: "openai/gpt-5",
      expectedToolCalls: [],
    },
  } as EvalIteration;
}

const full = run({ _id: "run-1", runNumber: 1, createdAt: 1_000 });
const rerun = run({
  _id: "run-2",
  runNumber: 2,
  createdAt: 2_000,
  completedAt: 2_500,
  replayedFromRunId: "run-1",
  rerunOfRunId: "run-1",
  rerunScope: "failed_cases",
});
const later = run({ _id: "run-3", runNumber: 3, createdAt: 3_000 });

// The full run: one case passed, one failed. The rerun re-ran only the failed
// one, which passed this time.
const fullRows = [
  iteration("a", "run-1", "passed", "case-a"),
  iteration("b", "run-1", "failed", "case-b"),
];
const rerunRows = [iteration("b2", "run-2", "passed", "case-b")];
const suite = { _id: "suite" } as unknown as EvalSuite;

describe("isSubsetRerunRun", () => {
  it("is keyed on the subset scope, not on lineage alone", () => {
    expect(isSubsetRerunRun(rerun)).toBe(true);
    expect(isSubsetRerunRun(run({ _id: "x", rerunOfRunId: "run-1" }))).toBe(
      false,
    );
    expect(isSubsetRerunRun(full)).toBe(false);
    expect(isSubsetRerunRun(null)).toBe(false);
  });
});

describe("a subset rerun is never part of a suite aggregate", () => {
  it("withoutSubsetRerunIterations drops its rows and keeps run-less ones", () => {
    const quick = { ...iteration("q", "", "passed"), suiteRunId: undefined };
    expect(
      withoutSubsetRerunIterations(
        [...fullRows, ...rerunRows, quick],
        [full, rerun],
      ).map((row) => row._id),
    ).toEqual(["a", "b", "q"]);
    // No rerun among the runs: the very same array comes back.
    const rows = [...fullRows];
    expect(withoutSubsetRerunIterations(rows, [full])).toBe(rows);
  });

  it("aggregateSuite counts each case once", () => {
    const aggregate = aggregateSuite(
      suite,
      [],
      [...fullRows, ...rerunRows],
      [full, rerun],
    );
    expect(aggregate.totals).toMatchObject({ passed: 1, failed: 1 });
    expect(
      aggregate.byCase.find((row) => row.testCaseId === "case-b"),
    ).toMatchObject({ runs: 1, passed: 0, failed: 1 });
  });

  it("useSuiteData's per-model stats skip it", () => {
    const { result } = renderHook(() =>
      useSuiteData(
        suite,
        [],
        [],
        [...fullRows, ...rerunRows],
        [full, rerun],
        null,
      ),
    );
    expect(
      result.current.modelStats.map((row) => [row.passed, row.total]),
    ).toEqual([[1, 2]]);
  });

  it("useSuiteDataFromMetrics' per-model stats skip it", () => {
    const { result } = renderHook(() =>
      useSuiteDataFromMetrics(
        [rerun, full],
        metricsByRunFromIterations([...fullRows, ...rerunRows]),
      ),
    );
    expect(
      result.current.modelStats.map((row) => [row.passed, row.total]),
    ).toEqual([[1, 2]]);
  });

  it("the suite hero's accuracy and latest run ignore it", () => {
    render(
      <SuiteHeroStats
        runs={[rerun, full]}
        allIterations={[...fullRows, ...rerunRows]}
        runTrendData={[]}
        modelStats={[]}
        testCaseCount={2}
        isSDK={false}
      />,
    );
    // 1 of 2, not 2 of 3: the rerun's pass of an already-failed case is not a
    // second data point for the suite.
    expect(screen.getAllByText("50%").length).toBeGreaterThan(0);
    expect(screen.getByText(/1\/\s*2 passed/)).toBeTruthy();
  });
});

describe("a subset rerun is never the latest run", () => {
  it("pickLatestCompletedRun skips it", () => {
    expect(pickLatestCompletedRun([rerun, full])?._id).toBe("run-1");
  });
});

describe("a subset rerun is never a baseline", () => {
  it("previousCompletedRunOf walks past it", () => {
    expect(previousCompletedRunOf(later, [later, rerun, full])?._id).toBe(
      "run-1",
    );
  });

  it("the previous launch is the last full run", () => {
    expect(
      previousLaunchRuns([later], [later, rerun, full])?.map((r) => r._id),
    ).toEqual(["run-1"]);
  });
});

describe("a subset rerun is never a trend point", () => {
  it("is absent from runTrendData (iterations)", () => {
    const { result } = renderHook(() =>
      useSuiteData(
        suite,
        [],
        [],
        [...fullRows, ...rerunRows],
        [later, rerun, full],
        null,
      ),
    );
    expect(result.current.runTrendData.map((point) => point.runId)).toEqual([
      "run-1",
    ]);
  });

  it("is absent from runTrendData (per-run metrics)", () => {
    const rows = [
      ...fullRows,
      ...rerunRows,
      iteration("c", "run-3", "passed"),
    ];
    const { result } = renderHook(() =>
      useSuiteDataFromMetrics(
        [later, rerun, full],
        metricsByRunFromIterations(rows),
      ),
    );
    expect(result.current.runTrendData.map((point) => point.runId)).toEqual([
      "run-1",
      "run-3",
    ]);
  });
});
