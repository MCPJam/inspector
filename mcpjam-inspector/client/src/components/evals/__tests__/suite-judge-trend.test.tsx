/**
 * WS4: the advisory judge-score trend.
 *
 * Two layers under test:
 *  - `computeRunJudgeScore` — the run-level mean of the goal-completion
 *    judge's per-case scores. Null (never zero) for unjudged runs, because
 *    the trend DROPS null points rather than plotting them.
 *  - `SuiteRunsChartGrid`'s Judge score card — its own card, never overlaid
 *    on the deterministic pass-rate chart, absent when nothing was judged,
 *    and wearing the ⚙ off-config marker for `judgeConfigOverride` runs.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { computeRunJudgeScore } from "../use-suite-data";
import { SuiteRunsChartGrid } from "../suite-runs-chart-grid";
import type { EvalSuiteRun } from "../types";

function runWith(goalCompletion?: {
  cases: Array<{ score: number }>;
}): EvalSuiteRun {
  return {
    _id: "run_1",
    runNumber: 1,
    createdAt: 1,
    ...(goalCompletion
      ? {
          goalCompletion: {
            summary: "s",
            generatedAt: 1,
            modelUsed: "m",
            threshold: 0.7,
            cases: goalCompletion.cases.map((c, i) => ({
              caseKey: `case-${i}`,
              score: c.score,
              passed: c.score >= 0.7,
              reason: "r",
              rubricHits: [],
            })),
          },
        }
      : {}),
  } as unknown as EvalSuiteRun;
}

describe("computeRunJudgeScore", () => {
  it("returns the whole-percent mean of per-case scores", () => {
    expect(
      computeRunJudgeScore(runWith({ cases: [{ score: 0.5 }, { score: 0.9 }] })),
    ).toBe(70);
  });

  it("returns null — never zero — for an unjudged run", () => {
    expect(computeRunJudgeScore(runWith())).toBeNull();
    expect(computeRunJudgeScore(runWith({ cases: [] }))).toBeNull();
  });

  it("ignores non-finite scores rather than poisoning the mean", () => {
    expect(
      computeRunJudgeScore(
        runWith({ cases: [{ score: Number.NaN }, { score: 0.8 }] }),
      ),
    ).toBe(80);
    expect(
      computeRunJudgeScore(runWith({ cases: [{ score: Number.NaN }] })),
    ).toBeNull();
  });
});

const TREND_BASE = {
  passRate: 50,
  passed: 1,
  total: 2,
};

describe("SuiteRunsChartGrid — judge score card", () => {
  it("is absent when no run in the window carries a judge verdict", () => {
    render(
      <SuiteRunsChartGrid
        runTrendData={[
          { ...TREND_BASE, runId: "r1", runIdDisplay: "1", label: "Run 1" },
          {
            ...TREND_BASE,
            runId: "r2",
            runIdDisplay: "2",
            label: "Run 2",
            judgeScore: null,
          },
        ]}
        modelStats={[]}
        runsLoading={false}
      />,
    );
    expect(screen.queryByTestId("suite-judge-trend")).toBeNull();
  });

  it("headlines the latest judged run and drops unjudged runs from the trend", () => {
    render(
      <SuiteRunsChartGrid
        runTrendData={[
          {
            ...TREND_BASE,
            runId: "r1",
            runIdDisplay: "1",
            label: "Run 1",
            judgeScore: 60,
          },
          // Unjudged run in the middle — dropped, not plotted as zero.
          {
            ...TREND_BASE,
            runId: "r2",
            runIdDisplay: "2",
            label: "Run 2",
            judgeScore: null,
          },
          {
            ...TREND_BASE,
            runId: "r3",
            runIdDisplay: "3",
            label: "Run 3",
            judgeScore: 82,
          },
        ]}
        modelStats={[]}
        runsLoading={false}
      />,
    );
    const card = screen.getByTestId("suite-judge-trend");
    expect(within(card).getByText("82%")).toBeTruthy();
    expect(card.textContent).toContain("Last 2 judged runs");
  });

  it("marks an off-config latest run with the ⚙ glyph in the headline", () => {
    render(
      <SuiteRunsChartGrid
        runTrendData={[
          {
            ...TREND_BASE,
            runId: "r1",
            runIdDisplay: "1",
            label: "Run 1",
            judgeScore: 75,
            judgeOffConfig: true,
          },
        ]}
        modelStats={[]}
        runsLoading={false}
      />,
    );
    const card = screen.getByTestId("suite-judge-trend");
    expect(card.textContent).toContain("⚙ judge override");
  });
});
