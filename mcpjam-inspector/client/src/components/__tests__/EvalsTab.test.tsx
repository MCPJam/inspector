import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { generateAndPersistEvalTestsMock } = vi.hoisted(() => ({
  generateAndPersistEvalTestsMock: vi.fn().mockResolvedValue({
    skippedBecauseExistingCases: false,
    createdCount: 0,
    apiReturnedTests: 0,
    createdTestCaseIds: [],
  }),
}));

const mocks = vi.hoisted(() => ({
  route: {
    current: { type: "suite-overview" as const, suiteId: "suite-a" },
  },
  useEvalQueries: vi.fn(),
  navigatePlaygroundEvalsRoute: vi.fn(),
  createTestSuiteMutation: vi.fn(),
  ensureAutoEvalSuiteMutation: vi.fn(),
  suiteIterationsView: vi.fn(),
  updateSuiteMutation: vi.fn(),
  handleGenerateTests: vi.fn(),
  isDirectGuest: false,
  connectedServerNames: new Set(["server-a", "server-b"]),
  appStateServers: {
    "server-a": { connectionStatus: "connected" },
    "server-b": { connectionStatus: "connected" },
  } as Record<string, Record<string, unknown>>,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    getAccessToken: vi.fn().mockResolvedValue("token"),
  }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
  useConvex: () => ({ query: vi.fn().mockResolvedValue([]) }),
}));

vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
}));

vi.mock("@/lib/evals/generate-and-persist-tests", () => ({
  generateAndPersistEvalTests: generateAndPersistEvalTestsMock,
}));

vi.mock("@/hooks/use-eval-tab-context", () => ({
  useEvalTabContext: () => ({
    connectedServerNames: mocks.connectedServerNames,
    userMap: new Map(),
    canDeleteSuite: false,
    canDeleteRuns: false,
    availableModels: [],
  }),
}));

vi.mock("@/hooks/useViews", () => ({
  useWorkspaceServers: () => ({
    servers: [
      { _id: "srv-a", name: "server-a", transportType: "http" },
      { _id: "srv-b", name: "server-b", transportType: "stdio" },
    ],
  }),
}));

vi.mock("@/hooks/use-is-direct-guest", () => ({
  useIsDirectGuest: () => mocks.isDirectGuest,
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({
    servers: mocks.appStateServers,
  }),
}));

vi.mock("@/lib/evals-router", () => ({
  useEvalsRoute: () => mocks.route.current,
}));

vi.mock("../evals/helpers", () => ({
  aggregateSuite: () => null,
}));

vi.mock("../evals/create-suite-navigation", () => ({
  navigatePlaygroundEvalsRoute: (...args: unknown[]) =>
    mocks.navigatePlaygroundEvalsRoute(...args),
  createPlaygroundSuiteNavigation: () => ({
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

vi.mock("../evals/ConfirmationDialogs", () => ({
  ConfirmationDialogs: () => null,
}));

vi.mock("../evals/evals-suite-list-sidebar", () => ({
  EvalsSuiteListSidebar: () => <div data-testid="suite-sidebar" />,
}));

vi.mock("../evals/use-playground-workspace-executions", () => ({
  usePlaygroundWorkspaceExecutions: () => ({
    status: "ready" as const,
    cases: [],
    iterations: [],
    iterationToSuiteId: new Map<string, string>(),
  }),
}));

vi.mock("../evals/create-suite-dialog", () => ({
  CreateSuiteDialog: ({
    open,
    onSubmit,
  }: {
    open: boolean;
    onSubmit: (payload: {
      name: string;
      description?: string;
      selectedServers: string[];
    }) => Promise<void>;
  }) =>
    open ? (
      <button
        type="button"
        onClick={() =>
          void onSubmit({
            name: "server-a",
            selectedServers: ["server-a"],
          })
        }
      >
        Submit create suite
      </button>
    ) : null,
}));

vi.mock("../evals/suite-iterations-view", () => ({
  SuiteIterationsView: (props: Record<string, unknown>) => {
    mocks.suiteIterationsView(props);
    return <div data-testid="suite-iterations-view" />;
  },
}));

vi.mock("../evals/use-eval-mutations", () => ({
  useEvalMutations: () => ({
    createTestSuiteMutation: mocks.createTestSuiteMutation,
    ensureAutoEvalSuiteMutation: mocks.ensureAutoEvalSuiteMutation,
    updateTestSuiteMutation: vi.fn().mockResolvedValue(undefined),
    createTestCaseMutation: vi.fn().mockResolvedValue("tc-1"),
  }),
}));

vi.mock("../evals/use-eval-handlers", () => ({
  useEvalHandlers: () => ({
    deletingSuiteId: null,
    suiteToDelete: null,
    setSuiteToDelete: vi.fn(),
    runToDelete: null,
    setRunToDelete: vi.fn(),
    testCaseToDelete: null,
    setTestCaseToDelete: vi.fn(),
    deletingRunId: null,
    deletingTestCaseId: null,
    rerunningSuiteId: null,
    cancellingRunId: null,
    runningTestCaseId: null,
    isGeneratingTests: false,
    handleGenerateTests: mocks.handleGenerateTests,
    handleCreateTestCase: vi.fn(),
    handleRerun: vi.fn(),
    handleCancelRun: vi.fn(),
    handleDelete: vi.fn(),
    handleDeleteRun: vi.fn(),
    directDeleteRun: vi.fn().mockResolvedValue(undefined),
    directDeleteTestCase: vi.fn().mockResolvedValue(undefined),
    handleRunTestCase: vi.fn().mockResolvedValue(undefined),
    confirmDelete: vi.fn(),
    confirmDeleteRun: vi.fn(),
    confirmDeleteTestCase: vi.fn(),
  }),
}));

vi.mock("../evals/use-eval-queries", () => ({
  useEvalQueries: (...args: unknown[]) => mocks.useEvalQueries(...args),
}));

import { EvalsTab } from "../EvalsTab";

function makeSuiteEntry(serverNames: string[], suiteId: string) {
  return {
    suite: {
      _id: suiteId,
      createdBy: "user-1",
      name: `Suite ${suiteId}`,
      description: "",
      configRevision: "rev-1",
      environment: { servers: serverNames },
      createdAt: 1,
      updatedAt: 1,
      source: "ui" as const,
      tags: ["explore"],
    },
    latestRun: null,
    recentRuns: [],
    passRateTrend: [],
    totals: { passed: 0, failed: 0, runs: 0 },
  };
}

function makeQueryState(selectedSuiteId: string | null) {
  const suiteA = makeSuiteEntry(["server-a"], "suite-a");
  const suiteB = makeSuiteEntry(["server-b", "server-c"], "suite-b");
  const sortedSuites = [suiteA, suiteB];
  const selectedSuiteEntry =
    sortedSuites.find((entry) => entry.suite._id === selectedSuiteId) ?? null;

  return {
    suiteOverview: sortedSuites,
    suiteDetails: selectedSuiteEntry
      ? {
          testCases: [],
          iterations: [],
        }
      : undefined,
    suiteRuns: selectedSuiteEntry ? [] : undefined,
    selectedSuiteEntry,
    selectedSuite: selectedSuiteEntry?.suite ?? null,
    sortedIterations: [],
    runsForSelectedSuite: [],
    activeIterations: [],
    sortedSuites,
    isOverviewLoading: false,
    isSuiteDetailsLoading: false,
    isSuiteRunsLoading: false,
    enableOverviewQuery: true,
    enableSuiteDetailsQuery: Boolean(selectedSuiteId),
  };
}

describe("EvalsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateAndPersistEvalTestsMock.mockResolvedValue({
      skippedBecauseExistingCases: false,
      createdCount: 0,
      apiReturnedTests: 0,
      createdTestCaseIds: [],
    });
    mocks.isDirectGuest = false;
    mocks.ensureAutoEvalSuiteMutation.mockResolvedValue({
      status: "created",
      suite: {
        _id: "suite-new",
        name: "server-a",
        description: "Explore cases for server-a",
      },
    });
    mocks.appStateServers = {
      "server-a": { connectionStatus: "connected" },
      "server-b": { connectionStatus: "connected" },
    };
    mocks.connectedServerNames = new Set(["server-a", "server-b"]);
    mocks.route.current = { type: "suite-overview", suiteId: "suite-a" };
    mocks.useEvalQueries.mockImplementation(
      ({ selectedSuiteId }: { selectedSuiteId: string | null }) =>
        makeQueryState(selectedSuiteId),
    );
  });

  it("renders from suite-driven route state without depending on an active server", () => {
    render(<EvalsTab workspaceId="ws-1" />);

    expect(mocks.navigatePlaygroundEvalsRoute).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Suites" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Executions" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(mocks.suiteIterationsView).toHaveBeenCalled();
    expect(mocks.suiteIterationsView.mock.calls.at(-1)?.[0]).toMatchObject({
      suite: expect.objectContaining({ _id: "suite-a" }),
      workspaceServers: expect.arrayContaining([
        expect.objectContaining({ name: "server-a" }),
        expect.objectContaining({ name: "server-b" }),
      ]),
    });
  });

  it("shows the suite list on the Suites tab when the route is the eval list", () => {
    mocks.route.current = { type: "list" };
    render(<EvalsTab workspaceId="ws-1" />);

    expect(screen.getByTestId("suite-sidebar")).toBeInTheDocument();
    expect(screen.queryByTestId("suite-iterations-view")).toBeNull();
  });

  it("navigates to the eval list when the Suites tab is activated while a suite is open", async () => {
    const user = userEvent.setup();
    render(<EvalsTab workspaceId="ws-1" />);
    expect(mocks.navigatePlaygroundEvalsRoute).not.toHaveBeenCalled();

    await user.click(screen.getByRole("tab", { name: "Suites" }));

    expect(mocks.navigatePlaygroundEvalsRoute).toHaveBeenCalledWith(
      { type: "list" },
      { replace: true },
    );
  });

  it("redirects invalid suite routes back to the eval list", async () => {
    mocks.route.current = { type: "suite-overview", suiteId: "missing-suite" };

    render(<EvalsTab workspaceId="ws-1" />);

    await waitFor(() => {
      expect(mocks.navigatePlaygroundEvalsRoute).toHaveBeenCalledWith(
        { type: "list" },
        { replace: true },
      );
    });
  });

  it("auto-creates missing server suites through ensureAutoEvalSuiteForServer", async () => {
    mocks.route.current = { type: "list" };
    mocks.useEvalQueries.mockImplementation(
      ({ selectedSuiteId }: { selectedSuiteId: string | null }) => {
        const suiteB = makeSuiteEntry(["server-b"], "suite-b");
        const selectedSuiteEntry =
          selectedSuiteId === "suite-b" ? suiteB : null;

        return {
          suiteOverview: [suiteB],
          suiteDetails: selectedSuiteEntry
            ? { testCases: [], iterations: [] }
            : undefined,
          suiteRuns: selectedSuiteEntry ? [] : undefined,
          selectedSuiteEntry,
          selectedSuite: selectedSuiteEntry?.suite ?? null,
          sortedIterations: [],
          runsForSelectedSuite: [],
          activeIterations: [],
          sortedSuites: [suiteB],
          isOverviewLoading: false,
          isSuiteDetailsLoading: false,
          isSuiteRunsLoading: false,
          enableOverviewQuery: true,
          enableSuiteDetailsQuery: Boolean(selectedSuiteId),
        };
      },
    );

    render(<EvalsTab workspaceId="ws-1" />);

    await waitFor(() => {
      expect(mocks.ensureAutoEvalSuiteMutation).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        serverName: "server-a",
        mode: "auto",
      });
    });

    expect(mocks.createTestSuiteMutation).not.toHaveBeenCalled();
  });

  it("does not auto-create suites again for suppressed servers", async () => {
    mocks.route.current = { type: "list" };
    mocks.appStateServers = {
      "server-a": {
        connectionStatus: "connected",
        autoEvalSuiteSuppressedAt: 123,
      },
      "server-b": { connectionStatus: "connected" },
    };
    mocks.useEvalQueries.mockImplementation(
      ({ selectedSuiteId }: { selectedSuiteId: string | null }) => {
        const suiteB = makeSuiteEntry(["server-b"], "suite-b");
        const selectedSuiteEntry =
          selectedSuiteId === "suite-b" ? suiteB : null;

        return {
          suiteOverview: [suiteB],
          suiteDetails: selectedSuiteEntry
            ? { testCases: [], iterations: [] }
            : undefined,
          suiteRuns: selectedSuiteEntry ? [] : undefined,
          selectedSuiteEntry,
          selectedSuite: selectedSuiteEntry?.suite ?? null,
          sortedIterations: [],
          runsForSelectedSuite: [],
          activeIterations: [],
          sortedSuites: [suiteB],
          isOverviewLoading: false,
          isSuiteDetailsLoading: false,
          isSuiteRunsLoading: false,
          enableOverviewQuery: true,
          enableSuiteDetailsQuery: Boolean(selectedSuiteId),
        };
      },
    );

    render(<EvalsTab workspaceId="ws-1" />);

    await waitFor(() => {
      expect(mocks.ensureAutoEvalSuiteMutation).not.toHaveBeenCalled();
    });
  });

  it("does not leak local suppression across workspaces with the same server name", async () => {
    mocks.route.current = { type: "list" };
    mocks.appStateServers = {
      "server-a": { connectionStatus: "connected" },
      "server-b": { connectionStatus: "connected" },
    };
    mocks.useEvalQueries.mockImplementation(
      ({ selectedSuiteId }: { selectedSuiteId: string | null }) => {
        const suiteB = makeSuiteEntry(["server-b"], "suite-b");
        const selectedSuiteEntry =
          selectedSuiteId === "suite-b" ? suiteB : null;

        return {
          suiteOverview: [suiteB],
          suiteDetails: selectedSuiteEntry
            ? { testCases: [], iterations: [] }
            : undefined,
          suiteRuns: selectedSuiteEntry ? [] : undefined,
          selectedSuiteEntry,
          selectedSuite: selectedSuiteEntry?.suite ?? null,
          sortedIterations: [],
          runsForSelectedSuite: [],
          activeIterations: [],
          sortedSuites: [suiteB],
          isOverviewLoading: false,
          isSuiteDetailsLoading: false,
          isSuiteRunsLoading: false,
          enableOverviewQuery: true,
          enableSuiteDetailsQuery: Boolean(selectedSuiteId),
        };
      },
    );
    mocks.ensureAutoEvalSuiteMutation.mockResolvedValue({
      status: "suppressed",
    });

    const { rerender } = render(<EvalsTab workspaceId="ws-1" />);

    await waitFor(() => {
      expect(mocks.ensureAutoEvalSuiteMutation).toHaveBeenNthCalledWith(1, {
        workspaceId: "ws-1",
        serverName: "server-a",
        mode: "auto",
      });
    });

    rerender(<EvalsTab workspaceId="ws-2" />);

    await waitFor(() => {
      expect(mocks.ensureAutoEvalSuiteMutation).toHaveBeenNthCalledWith(2, {
        workspaceId: "ws-2",
        serverName: "server-a",
        mode: "auto",
      });
    });
  });

  it("recreates a suppressed single-server suite from the create dialog", async () => {
    const user = userEvent.setup();
    mocks.route.current = { type: "create" };
    mocks.appStateServers = {
      "server-a": {
        connectionStatus: "connected",
        autoEvalSuiteSuppressedAt: 123,
      },
      "server-b": { connectionStatus: "connected" },
    };

    render(<EvalsTab workspaceId="ws-1" />);

    await user.click(screen.getByRole("button", { name: "Submit create suite" }));

    await waitFor(() => {
      expect(mocks.ensureAutoEvalSuiteMutation).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        serverName: "server-a",
        mode: "manual",
      });
    });

    expect(mocks.createTestSuiteMutation).not.toHaveBeenCalled();
    expect(generateAndPersistEvalTestsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        suiteId: "suite-new",
        serverIds: ["server-a"],
      }),
    );
    expect(mocks.navigatePlaygroundEvalsRoute).toHaveBeenCalledWith({
      type: "suite-overview",
      suiteId: "suite-new",
    });
  });

  it("recreates a suppressed single-server suite without generating cases when the server is disconnected", async () => {
    const user = userEvent.setup();
    mocks.route.current = { type: "create" };
    mocks.appStateServers = {
      "server-a": {
        connectionStatus: "disconnected",
        autoEvalSuiteSuppressedAt: 123,
      },
      "server-b": { connectionStatus: "connected" },
    };
    mocks.connectedServerNames = new Set(["server-b"]);

    render(<EvalsTab workspaceId="ws-1" />);

    await user.click(screen.getByRole("button", { name: "Submit create suite" }));

    await waitFor(() => {
      expect(mocks.ensureAutoEvalSuiteMutation).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        serverName: "server-a",
        mode: "manual",
      });
    });

    expect(generateAndPersistEvalTestsMock).not.toHaveBeenCalled();
    expect(mocks.navigatePlaygroundEvalsRoute).toHaveBeenCalledWith({
      type: "suite-overview",
      suiteId: "suite-new",
    });
  });

});
