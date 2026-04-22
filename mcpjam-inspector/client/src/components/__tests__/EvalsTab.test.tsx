import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mocks = vi.hoisted(() => ({
  route: {
    current: { type: "suite-overview" as const, suiteId: "suite-a" },
  },
  useEvalQueries: vi.fn(),
  navigatePlaygroundEvalsRoute: vi.fn(),
  createTestSuiteMutation: vi.fn(),
  suiteIterationsView: vi.fn(),
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

vi.mock("@/hooks/use-eval-tab-context", () => ({
  useEvalTabContext: () => ({
    connectedServerNames: new Set(["server-a", "server-b"]),
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
  CreateSuiteDialog: () => null,
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
    handleGenerateTests: vi.fn(),
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
    mocks.route.current = { type: "suite-overview", suiteId: "suite-a" };
    mocks.useEvalQueries.mockImplementation(
      ({ selectedSuiteId }: { selectedSuiteId: string | null }) =>
        makeQueryState(selectedSuiteId),
    );
  });

  it("renders from suite-driven route state without depending on an active server", () => {
    render(<EvalsTab workspaceId="ws-1" />);

    expect(mocks.navigatePlaygroundEvalsRoute).not.toHaveBeenCalled();
    expect(
      screen.getByRole("tab", { name: "Executions" }),
    ).toBeInTheDocument();
    expect(mocks.suiteIterationsView).toHaveBeenCalled();
    expect(mocks.suiteIterationsView.mock.calls.at(-1)?.[0]).toMatchObject({
      suite: expect.objectContaining({ _id: "suite-a" }),
      workspaceServers: expect.arrayContaining([
        expect.objectContaining({ name: "server-a" }),
        expect.objectContaining({ name: "server-b" }),
      ]),
    });
  });

  it("shows the suite list on the Suites tab", async () => {
    const user = userEvent.setup();
    render(<EvalsTab workspaceId="ws-1" />);

    expect(screen.getByTestId("suite-iterations-view")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Suites" }));
    expect(screen.getByTestId("suite-sidebar")).toBeInTheDocument();
    expect(screen.queryByTestId("suite-iterations-view")).toBeNull();
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
});
