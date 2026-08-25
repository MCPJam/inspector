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

const cloudState = vi.hoisted(() => ({
  ephemeralAvailable: true as boolean | undefined,
  environments: [] as Array<{
    environmentId: string;
    computerEnvironmentId?: string;
  }>,
}));
vi.mock("@/hooks/useProjectComputer", () => ({
  useEphemeralCloudAvailable: () => cloudState.ephemeralAvailable,
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => cloudState.environments,
}));

vi.mock("convex/react", () => ({
  useMutation: (name: any) => (mocks.useMutation as any)(name),
  useQuery: (name: any, args: any) => (mocks.useQuery as any)(name, args),
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: null, isLoading: false, signIn: vi.fn() }),
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));

vi.mock("../use-suite-data", () => ({
  useSuiteData: () => ({
    runTrendData: [],
    modelStats: [],
  }),
  useRunDetailData: () => ({
    caseGroupsForSelectedRun: [],
  }),
}));

vi.mock("../suite-header", () => ({
  SuiteHeader: (props: any) => {
    mocks.suiteHeader(props);
    return (
      <div data-testid="suite-header">{props.overviewModeSelector}</div>
    );
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

  it("opens test edit from the suite-detail case list when run actions are hidden", async () => {
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

    await user.click(screen.getByTestId("suite-test-case-row-case-1"));

    expect(navigation.toTestEdit).toHaveBeenCalledWith("suite-1", "case-1");
  });

  it("renders the Evaluate suite-detail identity row when run actions are hidden", () => {
    const navigation = {
      ...noopNav,
      toSuiteEdit: vi.fn(),
    };

    render(
      <SuiteIterationsView
        suite={{ ...baseSuite, name: "checkout-flow" }}
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

    expect(screen.getByTestId("suite-detail-overview")).toBeInTheDocument();
    expect(screen.getByTestId("suite-detail-identity")).toHaveTextContent(
      "checkout-flow",
    );
    expect(screen.queryByTestId("suite-header")).toBeNull();
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

describe("SuiteIterationsView cloud-sandbox gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cloudState.ephemeralAvailable = true;
    cloudState.environments = [];
    mocks.useMutation.mockReturnValue(vi.fn());
    mocks.useQuery.mockReturnValue(undefined);
  });

  function renderView(suite: EvalSuite, projectId?: string) {
    render(
      <SuiteIterationsView
        suite={suite}
        {...(projectId ? { projectId } : {})}
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
  }

  it("folds the preflight into the reason handed to EVERY run control", () => {
    // The parent derives the gate exactly once; the header (and the per-case
    // dashboards, which read the same shadowed variable) receive it as the
    // ordinary disabled-reason prop.
    cloudState.ephemeralAvailable = false;
    renderView({
      ...baseSuite,
      environment: { servers: [], computerEnvironmentId: "img-1" },
    });
    expect(mocks.suiteHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        evalRunsDisabledReason: expect.stringMatching(
          /can't run MCPJam cloud sandboxes/,
        ),
      }),
    );
  });

  it("catches a pin carried by an ATTACHED environment", () => {
    cloudState.ephemeralAvailable = false;
    cloudState.environments = [
      { environmentId: "env-9", computerEnvironmentId: "img-9" },
    ];
    renderView({ ...baseSuite, environmentIds: ["env-9"] }, "proj-1");
    expect(mocks.suiteHeader).toHaveBeenCalledWith(
      expect.objectContaining({
        evalRunsDisabledReason: expect.stringMatching(
          /can't run MCPJam cloud sandboxes/,
        ),
      }),
    );
  });

  it("passes no reason when the pinned suite CAN reach cloud sandboxes", () => {
    renderView({
      ...baseSuite,
      environment: { servers: [], computerEnvironmentId: "img-1" },
    });
    expect(mocks.suiteHeader).toHaveBeenCalledWith(
      expect.objectContaining({ evalRunsDisabledReason: null }),
    );
  });
});
