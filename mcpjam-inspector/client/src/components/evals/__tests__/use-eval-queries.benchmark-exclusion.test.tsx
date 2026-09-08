import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalSuiteOverviewEntry, EvalSuiteRun } from "../types";

const { mockUseQuery } = vi.hoisted(() => ({ mockUseQuery: vi.fn() }));

vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));
vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => true,
}));

import { useEvalQueries } from "../use-eval-queries";

/**
 * `"benchmark"` is cast in rather than declared on `EvalSuite["source"]`. The
 * union describes what an Evaluate list may CONTAIN, and the whole point of
 * the filter under test is that it may not contain this — so the fixture has
 * to be able to say something the type deliberately does not.
 */
function suiteEntry(id: string, source?: string): EvalSuiteOverviewEntry {
  return {
    suite: {
      _id: id,
      name: id,
      ...(source ? { source } : {}),
    } as EvalSuiteOverviewEntry["suite"],
    latestRun: null,
    recentRuns: [],
    passRateTrend: [],
    totals: { passed: 0, failed: 0, runs: 0 },
  };
}

function run(id: string, source?: string): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite_ui",
    ...(source ? { source } : {}),
  } as EvalSuiteRun;
}

/**
 * `getTestSuitesOverview` and `listTestSuiteRuns` are answered in the order
 * `useEvalQueries` subscribes to them.
 */
function answerQueries(answers: {
  overview?: EvalSuiteOverviewEntry[] | undefined;
  runs?: EvalSuiteRun[] | undefined;
}) {
  mockUseQuery.mockImplementation((name: string) => {
    if (name === "testSuites:getTestSuitesOverview") return answers.overview;
    if (name === "testSuites:listTestSuiteRuns") return answers.runs;
    return undefined;
  });
}

function renderQueries() {
  return renderHook(() =>
    useEvalQueries({
      isAuthenticated: true,
      selectedSuiteId: "suite_ui",
      deletingSuiteId: null,
      projectId: "proj_1",
      organizationId: null,
    }),
  );
}

beforeEach(() => {
  mockUseQuery.mockReset();
});

/**
 * The filtering is SERVER-SIDE. This pins that the client does not put those
 * rows back: an Evaluate list is assembled from more than one read, and every
 * join is a place a filtered row can walk back in through a projection that
 * carried it for another reason.
 *
 * It matters because Evaluate's affordances — Edit, Re-run, Delete — are
 * meaningless against an immutable exam whose runs are evidence for a
 * published score.
 */
describe("benchmark-owned rows never reach the Evaluate lists", () => {
  it("drops a benchmark suite from the overview", () => {
    answerQueries({
      overview: [
        suiteEntry("suite_ui", "ui"),
        suiteEntry("suite_bench", "benchmark"),
      ],
    });

    const { result } = renderQueries();

    expect(result.current.suiteOverview?.map((e) => e.suite._id)).toEqual([
      "suite_ui",
    ]);
    expect(result.current.sortedSuites.map((e) => e.suite._id)).toEqual([
      "suite_ui",
    ]);
  });

  it("drops a benchmark run from the selected suite's run list", () => {
    answerQueries({
      overview: [suiteEntry("suite_ui", "ui")],
      runs: [run("run_ui", "ui"), run("run_bench", "benchmark")],
    });

    const { result } = renderQueries();

    expect(result.current.suiteRuns?.map((r) => r._id)).toEqual(["run_ui"]);
    expect(result.current.runsForSelectedSuite.map((r) => r._id)).toEqual([
      "run_ui",
    ]);
  });

  it("leaves every other source alone", () => {
    answerQueries({
      overview: [suiteEntry("suite_ui", "ui"), suiteEntry("suite_sdk", "sdk")],
      runs: [
        run("run_ui", "ui"),
        run("run_ci", "github_check"),
        run("run_sched", "schedule"),
        run("run_legacy"),
      ],
    });

    const { result } = renderQueries();

    expect(result.current.suiteOverview).toHaveLength(2);
    expect(result.current.suiteRuns?.map((r) => r._id)).toEqual([
      "run_ui",
      "run_ci",
      "run_sched",
      "run_legacy",
    ]);
  });

  it("keeps `undefined` meaning loading rather than collapsing it to empty", () => {
    answerQueries({ overview: undefined, runs: undefined });

    const { result } = renderQueries();

    // Turning an in-flight read into `[]` here would flash the "no suites"
    // hero over a project that has some.
    expect(result.current.suiteOverview).toBeUndefined();
    expect(result.current.isOverviewLoading).toBe(true);
    expect(result.current.suiteRuns).toBeUndefined();
    expect(result.current.isSuiteRunsLoading).toBe(true);
  });
});
