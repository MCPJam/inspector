import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type {
  EvalSuite,
  EvalSuiteOverviewEntry,
  EvalSuiteRun,
} from "../evals/types";

const mocks = vi.hoisted(() => ({
  route: {
    current: { type: "list" as const } as any,
  },
  useEvalQueries: vi.fn(),
  deleteSuiteMutation: vi.fn(),
  directDeleteRun: vi.fn().mockResolvedValue(undefined),
  navigateToCiEvalsRoute: vi.fn(),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
  }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({}),
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("@/lib/ci-evals-router", () => ({
  useCiEvalsRoute: () => mocks.route.current,
  navigateToCiEvalsRoute: (...args: unknown[]) =>
    mocks.navigateToCiEvalsRoute(...args),
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div />,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({
    children,
    ...props
  }: {
    children: ReactNode;
    [key: string]: unknown;
  }) => <div {...props}>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../evals/use-eval-mutations", () => ({
  useEvalMutations: () => ({
    deleteSuiteMutation: mocks.deleteSuiteMutation,
  }),
}));

vi.mock("../evals/use-eval-queries", () => ({
  useEvalQueries: (...args: unknown[]) => mocks.useEvalQueries(...args),
}));

vi.mock("../evals/use-eval-handlers", () => ({
  useEvalHandlers: () => ({
    handleRerun: vi.fn(),
    handleReplayRun: vi.fn(),
    handleCancelRun: vi.fn(),
    directDeleteRun: mocks.directDeleteRun,
    rerunningSuiteId: null,
    replayingRunId: null,
    cancellingRunId: null,
    handleCreateTestCase: vi.fn(),
    handleDuplicateTestCase: vi.fn(),
    handleGenerateTests: vi.fn(),
  }),
}));

vi.mock("../evals/use-suite-data", () => ({
  useRunDetailData: () => ({
    caseGroupsForSelectedRun: [],
  }),
}));

vi.mock("../evals/create-suite-navigation", () => ({
  createCiSuiteNavigation: () => ({
    toSuiteOverview: vi.fn(),
    toRunDetail: vi.fn(),
    toTestDetail: vi.fn(),
    toTestEdit: vi.fn(),
    toSuiteEdit: vi.fn(),
  }),
}));

vi.mock("../evals/EvalTabGate", () => ({
  EvalTabGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../evals/ci-suite-list-sidebar", () => ({
  CiSuiteListSidebar: () => <div data-testid="ci-suite-list-sidebar" />,
}));

vi.mock("../evals/commit-detail-view", () => ({
  CommitDetailView: () => <div data-testid="commit-detail-view" />,
}));

vi.mock("../evals/suite-iterations-view", () => ({
  SuiteIterationsView: () => <div data-testid="suite-iterations-view" />,
}));

vi.mock("../evals/sdk-eval-quickstart", () => ({
  SdkEvalQuickstart: () => <div data-testid="sdk-eval-quickstart" />,
}));

vi.mock("../evals/trace-viewer", () => ({
  TraceViewer: () => <div data-testid="trace-viewer" />,
}));

vi.mock("@/hooks/use-eval-tab-context", () => ({
  useEvalTabContext: () => ({
    connectedServerNames: new Set(),
    userMap: new Map(),
    canDeleteSuite: false,
    canDeleteRuns: false,
    availableModels: [],
  }),
}));

import { CiEvalsTab } from "../CiEvalsTab";

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user-1",
    runNumber: 1,
    configRevision: "rev-1",
    configSnapshot: {
      tests: [],
      environment: { servers: [] },
    },
    status: "completed",
    result: "passed",
    summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
    createdAt: 1,
    completedAt: 2,
    ...overrides,
  };
}

function makeSuite(overrides: Partial<EvalSuite> = {}): EvalSuite {
  return {
    _id: "suite-1",
    createdBy: "user-1",
    name: "Greeting suite",
    description: "",
    configRevision: "rev-1",
    environment: { servers: [] },
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeEntry(
  overrides: Partial<EvalSuiteOverviewEntry> = {},
): EvalSuiteOverviewEntry {
  const latestRun =
    overrides.latestRun === undefined ? null : overrides.latestRun;
  return {
    suite: makeSuite(),
    latestRun,
    recentRuns: latestRun ? [latestRun] : [],
    passRateTrend: [],
    totals: {
      passed: latestRun ? 1 : 0,
      failed: 0,
      runs: latestRun ? 1 : 0,
    },
    ...overrides,
  };
}

function makeQueries(
  overrides: Partial<ReturnType<typeof baseQueries>> = {},
): ReturnType<typeof baseQueries> {
  return {
    ...baseQueries(),
    ...overrides,
  };
}

function baseQueries() {
  return {
    suiteOverview: [],
    suiteDetails: undefined,
    suiteRuns: undefined,
    selectedSuiteEntry: null,
    selectedSuite: null,
    sortedIterations: [],
    runsForSelectedSuite: [],
    activeIterations: [],
    sortedSuites: [],
    isOverviewLoading: false,
    isSuiteDetailsLoading: false,
    isSuiteRunsLoading: false,
    enableOverviewQuery: true,
    enableSuiteDetailsQuery: false,
  };
}

describe("CiEvalsTab first-run NUX", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.route.current = { type: "list" };
    mocks.useEvalQueries.mockReturnValue(baseQueries());
  });

  it("shows a loading state instead of flashing the NUX while overview data is loading", () => {
    mocks.useEvalQueries.mockReturnValue(
      makeQueries({
        isOverviewLoading: true,
      }),
    );

    render(<CiEvalsTab convexWorkspaceId="ws-1" />);

    expect(screen.getByText("Loading runs...")).toBeInTheDocument();
    expect(screen.queryByText("Run your first eval")).not.toBeInTheDocument();
  });

  it("shows the first-run NUX when there are no suites and no runs after loading", () => {
    render(<CiEvalsTab convexWorkspaceId="ws-1" />);

    expect(screen.getByText("Run your first eval")).toBeInTheDocument();
    expect(screen.getByTestId("sdk-eval-quickstart")).toBeInTheDocument();
    expect(
      screen.queryByText("Select a suite or commit"),
    ).not.toBeInTheDocument();
  });

  it("hides the first-run NUX when suites exist even before any runs", () => {
    mocks.route.current = { type: "suite-overview", suiteId: "suite-1" };
    mocks.useEvalQueries.mockReturnValue(
      makeQueries({
        sortedSuites: [makeEntry()],
      }),
    );

    render(<CiEvalsTab convexWorkspaceId="ws-1" />);

    expect(screen.queryByText("Run your first eval")).not.toBeInTheDocument();
    expect(screen.getByTestId("suite-iterations-view")).toBeInTheDocument();
  });

  it("hides the first-run NUX once any suite has a run", () => {
    const run = makeRun();
    mocks.route.current = { type: "suite-overview", suiteId: "suite-1" };
    mocks.useEvalQueries.mockReturnValue(
      makeQueries({
        sortedSuites: [makeEntry({ latestRun: run, recentRuns: [run] })],
      }),
    );

    render(<CiEvalsTab convexWorkspaceId="ws-1" />);

    expect(screen.queryByText("Run your first eval")).not.toBeInTheDocument();
    expect(screen.getByTestId("suite-iterations-view")).toBeInTheDocument();
  });
});
