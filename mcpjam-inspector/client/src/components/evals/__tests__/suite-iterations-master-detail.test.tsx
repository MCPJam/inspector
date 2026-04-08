import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SuiteIterationsView } from "../suite-iterations-view";
import type { EvalSuite } from "../types";

const mocks = vi.hoisted(() => ({
  useMutation: vi.fn(() => vi.fn()),
  useQuery: vi.fn(),
  suiteHeader: vi.fn(),
  runOverview: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: (name: any) => (mocks.useMutation as any)(name),
  useQuery: (name: any, args: any) => (mocks.useQuery as any)(name, args),
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
  SuiteHeader: (props: unknown) => {
    mocks.suiteHeader(props);
    return <div data-testid="suite-header" />;
  },
}));

vi.mock("../eval-export-modal", () => ({
  EvalExportModal: () => null,
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({ servers: {} }),
}));

vi.mock("../run-overview", () => ({
  RunOverview: (props: unknown) => {
    mocks.runOverview(props);
    return <div data-testid="run-overview" />;
  },
}));

vi.mock("../suite-hero-stats", () => ({
  SuiteHeroStats: () => <div data-testid="suite-hero-stats" />,
}));

vi.mock("../test-cases-overview", () => ({
  TestCasesOverview: ({
    onTestCaseClick,
    onOpenLastRun,
  }: {
    onTestCaseClick: (testCaseId: string) => void;
    onOpenLastRun?: (testCaseId: string, iterationId: string) => void;
  }) => (
    <div>
      <button
        type="button"
        data-testid="test-cases-overview"
        onClick={() => onTestCaseClick("case-1")}
      >
        Click on a case to view its run history and performance.
      </button>
      <button
        type="button"
        data-testid="test-cases-open-last-run"
        onClick={() => onOpenLastRun?.("case-1", "iter-1")}
      >
        Open last run
      </button>
    </div>
  ),
}));

const noopNav = {
  toSuiteOverview: vi.fn(),
  toRunDetail: vi.fn(),
  toTestDetail: vi.fn(),
  toTestEdit: vi.fn(),
  toSuiteEdit: vi.fn(),
};

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
    vi.clearAllMocks();
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
        canDeleteSuite={false}
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
        navigation={noopNav}
        caseListInSidebar
      />,
    );

    expect(screen.queryByTestId("test-cases-overview")).toBeNull();
    expect(
      screen.getByText(/Select a case from the list on the left/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("suite-hero-stats")).toBeInTheDocument();
  });

  it("replaces run-oriented overview chrome when run actions are hidden", () => {
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
        canDeleteSuite={false}
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
        navigation={noopNav}
        caseListInSidebar
        hideRunActions
      />,
    );

    expect(screen.queryByTestId("suite-hero-stats")).toBeNull();
    expect(screen.getByText(/run it individually/i)).toBeInTheDocument();
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
        canDeleteSuite={false}
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
        navigation={noopNav}
      />,
    );

    expect(screen.getByTestId("test-cases-overview")).toBeInTheDocument();
  });

  it("opens test edit with compare deep link from the cases list when run actions are hidden", async () => {
    const user = userEvent.setup();
    const navigation = {
      ...noopNav,
      toTestEdit: vi.fn(),
    };

    render(
      <SuiteIterationsView
        suite={baseSuite}
        cases={[
          {
            _id: "case-1",
            testSuiteId: "suite-1",
            createdBy: "u",
            title: "Case 1",
            query: "Prompt",
            models: [],
            runs: 1,
            expectedToolCalls: [],
          },
        ]}
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
        canDeleteSuite={false}
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
        navigation={navigation}
        hideRunActions
      />,
    );

    await user.click(screen.getByTestId("test-cases-overview"));

    expect(navigation.toTestEdit).toHaveBeenCalledWith(
      "suite-1",
      "case-1",
    );
  });

  it("preserves the clicked iteration when opening compare from the cases list", async () => {
    const user = userEvent.setup();
    const navigation = {
      ...noopNav,
      toTestEdit: vi.fn(),
    };

    render(
      <SuiteIterationsView
        suite={baseSuite}
        cases={[
          {
            _id: "case-1",
            testSuiteId: "suite-1",
            createdBy: "u",
            title: "Case 1",
            query: "Prompt",
            models: [],
            runs: 1,
            expectedToolCalls: [],
          },
        ]}
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
        canDeleteSuite={false}
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
        navigation={navigation}
        hideRunActions
      />,
    );

    await user.click(screen.getByTestId("test-cases-open-last-run"));

    expect(navigation.toTestEdit).toHaveBeenCalledWith(
      "suite-1",
      "case-1",
      {
        openCompare: true,
        iteration: "iter-1",
      },
    );
  });

  it("passes canDeleteSuite through to RunOverview in read-only overview (runs view)", () => {
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
        canDeleteSuite
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
        navigation={noopNav}
        readOnlyConfig
      />,
    );

    expect(mocks.runOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        canDeleteSuite: true,
      }),
    );
  });
});
