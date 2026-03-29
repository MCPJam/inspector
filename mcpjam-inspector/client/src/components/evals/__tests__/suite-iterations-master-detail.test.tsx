import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SuiteIterationsView } from "../suite-iterations-view";
import type { EvalSuite } from "../types";

const mocks = vi.hoisted(() => ({
  useMutation: vi.fn(() => vi.fn()),
  useQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: (...args: unknown[]) => mocks.useMutation(...args),
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
}));

vi.mock("../use-suite-data", () => ({
  useSuiteData: () => ({
    runTrendData: [],
    modelStats: [],
  }),
  useRunDetailData: () => ({
    caseGroupsForSelectedRun: [],
    selectedRunChartData: [],
  }),
}));

vi.mock("../suite-header", () => ({
  SuiteHeader: () => <div data-testid="suite-header" />,
}));

vi.mock("../run-overview", () => ({
  RunOverview: () => <div data-testid="run-overview" />,
}));

vi.mock("../suite-hero-stats", () => ({
  SuiteHeroStats: () => <div data-testid="suite-hero-stats" />,
}));

vi.mock("../test-cases-overview", () => ({
  TestCasesOverview: () => (
    <div data-testid="test-cases-overview">
      Click on a case to view its run history and performance.
    </div>
  ),
}));

const baseSuite: EvalSuite = {
  _id: "suite-1",
  createdBy: "u",
  name: "Test Suite",
  description: "",
  configRevision: "r",
  environment: { servers: [] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
};

describe("SuiteIterationsView caseListInSidebar", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.useMutation.mockReturnValue(vi.fn());
    mocks.useQuery.mockImplementation((_name: string, args: unknown) => {
      if (args === "skip") {
        return undefined;
      }
      return undefined;
    });
  });

  it("does not mount TestCasesOverview when case index is in the parent sidebar", () => {
    render(
      <SuiteIterationsView
        suite={baseSuite}
        cases={[]}
        iterations={[]}
        allIterations={[]}
        runs={[]}
        runsLoading={false}
        aggregate={null}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        onDelete={vi.fn()}
        onDeleteRun={vi.fn()}
        onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
        connectedServerNames={new Set()}
        rerunningSuiteId={null}
        cancellingRunId={null}
        deletingSuiteId={null}
        deletingRunId={null}
        availableModels={[]}
        route={{
          type: "suite-overview",
          suiteId: "suite-1",
          view: "test-cases",
        }}
        caseListInSidebar
      />,
    );

    expect(screen.queryByTestId("test-cases-overview")).toBeNull();
    expect(
      screen.getByText(/Select a case from the list on the left/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("suite-hero-stats")).toBeInTheDocument();
  });

  it("still mounts TestCasesOverview without caseListInSidebar", () => {
    render(
      <SuiteIterationsView
        suite={baseSuite}
        cases={[]}
        iterations={[]}
        allIterations={[]}
        runs={[]}
        runsLoading={false}
        aggregate={null}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        onDelete={vi.fn()}
        onDeleteRun={vi.fn()}
        onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
        connectedServerNames={new Set()}
        rerunningSuiteId={null}
        cancellingRunId={null}
        deletingSuiteId={null}
        deletingRunId={null}
        availableModels={[]}
        route={{
          type: "suite-overview",
          suiteId: "suite-1",
          view: "test-cases",
        }}
      />,
    );

    expect(screen.getByTestId("test-cases-overview")).toBeInTheDocument();
  });

  it("renders terminal trace repair outcome details on the suite overview", () => {
    mocks.useQuery.mockImplementation((name: string, args: unknown) => {
      if (args === "skip") {
        return undefined;
      }
      if (name === "traceRepair:getTraceRepairJobView") {
        return null;
      }
      if (name === "traceRepair:getLatestTraceRepairOutcome") {
        return {
          jobId: "job-1",
          status: "completed",
          phase: "finalizing",
          scope: "suite",
          stopReason: "completed_server_likely",
          updatedAt: 1,
          completedAt: 1,
          accuracyBefore: 0.75,
          accuracyAfter: 0.875,
          provisionalAppliedCount: 0,
          durableFixCount: 1,
          regressedCount: 1,
          serverLikelyCount: 1,
        };
      }
      if (name === "traceRepair:getTraceRepairJobDebugJson") {
        return { job: { _id: "job-1" }, sessions: [] };
      }
      return undefined;
    });

    render(
      <SuiteIterationsView
        suite={baseSuite}
        cases={[]}
        iterations={[]}
        allIterations={[]}
        runs={[]}
        runsLoading={false}
        aggregate={null}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        onDelete={vi.fn()}
        onDeleteRun={vi.fn()}
        onDirectDeleteRun={vi.fn().mockResolvedValue(undefined)}
        connectedServerNames={new Set()}
        rerunningSuiteId={null}
        cancellingRunId={null}
        deletingSuiteId={null}
        deletingRunId={null}
        availableModels={[]}
        route={{
          type: "suite-overview",
          suiteId: "suite-1",
          view: "runs",
        }}
      />,
    );

    expect(screen.getByText("Trace repair finished")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Provisional applied: 0 · Durable fixes: 1 · Regressed: 1 · Likely server: 1",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Accuracy 75% → 88%"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No promotions; repeated failures matched the same signature."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Copy JSON/i }),
    ).toBeInTheDocument();
  });
});
