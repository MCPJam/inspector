import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  route: {
    current: {
      type: "test-edit" as const,
      suiteId: "suite-a",
      testId: "case-a",
      openCompare: true,
      iteration: "iter-a",
    },
  },
  useEvalQueries: vi.fn(),
  navigatePlaygroundEvalsRoute: vi.fn(),
  createTestSuiteMutation: vi.fn(),
  updateSuiteMutation: vi.fn(),
  handleGenerateTests: vi.fn(),
  ensureGuestSuite: vi.fn(),
  isDirectGuest: false,
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
  useMutation: () => mocks.updateSuiteMutation,
}));

vi.mock("@/hooks/use-eval-tab-context", () => ({
  useEvalTabContext: () => ({
    connectedServerNames: new Set(["server-a", "server-b"]),
    userMap: new Map(),
    canDeleteSuite: false,
    canDeleteRuns: false,
    availableModels: [],
  }),
}));

vi.mock("@/hooks/use-is-direct-guest", () => ({
  useIsDirectGuest: () => mocks.isDirectGuest,
}));

vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({
    servers: {
      "server-a": { connectionStatus: "connected" },
      "server-b": { connectionStatus: "connected" },
    },
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

vi.mock("../evals/suite-iterations-view", () => ({
  SuiteIterationsView: () => <div data-testid="suite-iterations-view" />,
}));

vi.mock("../evals/use-eval-mutations", () => ({
  useEvalMutations: () => ({
    createTestSuiteMutation: mocks.createTestSuiteMutation,
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

vi.mock("@/stores/guest-evals-store", () => ({
  useGuestEvalsStore: (selector: (state: { ensureSuite: typeof mocks.ensureGuestSuite }) => unknown) =>
    selector({
      ensureSuite: mocks.ensureGuestSuite,
    }),
}));

vi.mock("../evals/use-eval-queries", () => ({
  useEvalQueries: (...args: unknown[]) => mocks.useEvalQueries(...args),
}));

import { EvalsTab } from "../EvalsTab";

function makeSuiteEntry(serverName: string, suiteId: string) {
  return {
    suite: {
      _id: suiteId,
      createdBy: "user-1",
      name: serverName,
      description: "",
      configRevision: "rev-1",
      environment: { servers: [serverName] },
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

function makeSuiteQueries(serverName: string, suiteId: string, testId: string) {
  const entry = makeSuiteEntry(serverName, suiteId);
  return {
    suiteOverview: [makeSuiteEntry("server-a", "suite-a"), entry],
    suiteDetails: {
      testCases: [
        {
          _id: testId,
          testSuiteId: suiteId,
          createdBy: "user-1",
          title: `${serverName} case`,
          query: "Q",
          models: [{ provider: "openai", model: "gpt-4" }],
          runs: 1,
          expectedToolCalls: [],
        },
      ],
      iterations: [],
    },
    suiteRuns: [
      {
        _id: `${suiteId}-run-1`,
        suiteId,
        createdBy: "user-1",
        runNumber: 1,
        configRevision: "rev-1",
        configSnapshot: {
          tests: [],
          environment: { servers: [serverName] },
        },
        status: "completed" as const,
        result: "passed" as const,
        summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
        createdAt: 1,
        completedAt: 2,
      },
    ],
    selectedSuiteEntry: entry,
    selectedSuite: entry.suite,
    sortedIterations: [],
    runsForSelectedSuite: [
      {
        _id: `${suiteId}-run-1`,
        suiteId,
        createdBy: "user-1",
        runNumber: 1,
        configRevision: "rev-1",
        configSnapshot: {
          tests: [],
          environment: { servers: [serverName] },
        },
        status: "completed" as const,
        result: "passed" as const,
        summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
        createdAt: 1,
        completedAt: 2,
      },
    ],
    activeIterations: [],
    sortedSuites: [makeSuiteEntry("server-a", "suite-a"), entry],
    isOverviewLoading: false,
    isSuiteDetailsLoading: false,
    isSuiteRunsLoading: false,
    enableOverviewQuery: true,
    enableSuiteDetailsQuery: true,
  };
}

describe("EvalsTab route guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDirectGuest = false;
    mocks.route.current = {
      type: "test-edit",
      suiteId: "suite-a",
      testId: "case-a",
      openCompare: true,
      iteration: "iter-a",
    };
    mocks.useEvalQueries.mockImplementation(
      ({ selectedSuiteId }: { selectedSuiteId: string | null }) => {
        const overview = {
          suiteOverview: [
            makeSuiteEntry("server-a", "suite-a"),
            makeSuiteEntry("server-b", "suite-b"),
          ],
          suiteDetails: undefined,
          suiteRuns: undefined,
          selectedSuiteEntry: null,
          selectedSuite: null,
          sortedIterations: [],
          runsForSelectedSuite: [],
          activeIterations: [],
          sortedSuites: [
            makeSuiteEntry("server-a", "suite-a"),
            makeSuiteEntry("server-b", "suite-b"),
          ],
          isOverviewLoading: false,
          isSuiteDetailsLoading: false,
          isSuiteRunsLoading: false,
          enableOverviewQuery: true,
          enableSuiteDetailsQuery: false,
        };

        if (!selectedSuiteId) {
          return overview;
        }

        if (selectedSuiteId === "suite-a") {
          return makeSuiteQueries("server-a", "suite-a", "case-a");
        }

        if (selectedSuiteId === "suite-b") {
          return makeSuiteQueries("server-b", "suite-b", "case-b");
        }

        return overview;
      },
    );
  });

  it("redirects stale compare routes to the newly selected server's cases view", async () => {
    const view = render(
      <EvalsTab selectedServer="server-a" workspaceId="ws-1" />,
    );

    expect(mocks.navigatePlaygroundEvalsRoute).not.toHaveBeenCalled();

    view.rerender(<EvalsTab selectedServer="server-b" workspaceId="ws-1" />);

    await waitFor(() => {
      expect(mocks.navigatePlaygroundEvalsRoute).toHaveBeenCalledWith(
        {
          type: "suite-overview",
          suiteId: "suite-b",
          view: "test-cases",
        },
        { replace: true },
      );
    });
  });

  it("creates the signed-in suite after a guest initialized the same server in the same tab", async () => {
    mocks.useEvalQueries.mockReturnValue({
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
    });
    mocks.createTestSuiteMutation.mockResolvedValue({ _id: "suite-created" });

    mocks.isDirectGuest = true;
    const view = render(
      <EvalsTab selectedServer="server-a" workspaceId="ws-1" />,
    );

    await waitFor(() => {
      expect(mocks.ensureGuestSuite).toHaveBeenCalledWith("server-a");
    });

    mocks.isDirectGuest = false;
    view.rerender(<EvalsTab selectedServer="server-a" workspaceId="ws-1" />);

    await waitFor(() => {
      expect(mocks.createTestSuiteMutation).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        name: "server-a",
        description: "Explore cases for server-a",
        environment: { servers: ["server-a"] },
      });
    });

    await waitFor(() => {
      expect(mocks.updateSuiteMutation).toHaveBeenCalledWith({
        suiteId: "suite-created",
        tags: ["explore"],
      });
      expect(mocks.handleGenerateTests).toHaveBeenCalledWith(
        "suite-created",
        ["server-a"],
      );
    });
  });

  it("does not create a guest suite when selectedServer is \"none\"", async () => {
    mocks.useEvalQueries.mockReturnValue({
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
    });

    mocks.isDirectGuest = true;

    render(<EvalsTab selectedServer="none" workspaceId="ws-1" />);

    await waitFor(() => {
      expect(mocks.ensureGuestSuite).not.toHaveBeenCalled();
    });
  });
});
