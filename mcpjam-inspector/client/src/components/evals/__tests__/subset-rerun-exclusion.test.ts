import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { isSubsetRerunRun, pickLatestCompletedRun } from "../helpers";
import { useSuiteDataFromMetrics } from "../use-suite-data";
import { metricsByRunFromIterations } from "../run-metrics";
import {
  previousCompletedRunOf,
  previousHeroIterations,
} from "../../evaluate/run-verdict-hero-deltas";
import type { EvalIteration, EvalSuiteRun } from "../types";

/**
 * E3 — a subset rerun re-ran only the cases that did not pass, so its pass
 * rate is biased by that selection. It may be shown, but it is never the
 * "latest run" a number describes, a trend point, or a baseline.
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
): EvalIteration {
  return {
    _id: id,
    suiteRunId,
    testCaseId: "case-1",
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
  replayedFromRunId: "run-1",
  rerunOfRunId: "run-1",
  rerunScope: "failed_cases",
});
const later = run({ _id: "run-3", runNumber: 3, createdAt: 3_000 });

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
    const fullRow = iteration("it-1", "run-1", "failed");
    const rerunRow = iteration("it-2", "run-2", "passed");
    expect(
      previousHeroIterations({
        selectedRuns: [later],
        suiteRuns: [later, rerun, full],
        allIterations: [fullRow, rerunRow],
      }),
    ).toEqual([fullRow]);
  });
});

describe("a subset rerun is never a trend point", () => {
  it("is absent from runTrendData", () => {
    const rows = [
      iteration("a", "run-1", "failed"),
      iteration("b", "run-2", "passed"),
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

describe("a subset rerun feeds no suite-level aggregate", () => {
  it("the hero's accuracy, run count and latest run ignore it", async () => {
    const { screen } = await import("@testing-library/react");
    const React = await import("react");
    const { renderWithProviders } = await import("@/test");
    const { SuiteHeroStats } = await import("../suite-hero-stats");
    // The full run passed its one trial; the subset rerun of its (now fixed)
    // failures is all fails. Counting the rerun would drag accuracy to 50%.
    renderWithProviders(
      React.createElement(SuiteHeroStats, {
        runs: [
          { ...full, completedAt: 1_500 },
          { ...rerun, completedAt: 99_999 },
        ],
        allIterations: [
          iteration("i-full", "run-1", "passed"),
          iteration("i-rerun", "run-2", "failed"),
        ],
        runTrendData: [],
        modelStats: [],
        testCaseCount: 1,
        isSDK: false,
      }),
    );
    expect(screen.getAllByText("100%").length).toBeGreaterThan(0);
    expect(screen.queryByText("50%")).toBeNull();
  });
});
