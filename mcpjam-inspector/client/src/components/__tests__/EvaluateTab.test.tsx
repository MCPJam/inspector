import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { executeInspectorCommand } from "@/lib/inspector-command-handlers";
import { readSurfaceSnapshot } from "@/lib/webmcp/surface-snapshot-registry";
import type {
  InspectorCommand,
  InspectorCommandResponse,
} from "@/shared/inspector-command.js";

const mocks = vi.hoisted(() => ({
  route: {
    current: { type: "suite-overview" as const, suiteId: "suite-a" },
  },
  useEvalQueries: vi.fn(),
  navigatePlaygroundEvalsRoute: vi.fn(),
  toSuiteOverview: vi.fn(),
  createTestSuiteMutation: vi.fn(),
  createSuitePage: vi.fn(() => null),
  suiteIterationsView: vi.fn(),
  projectRunsTable: vi.fn(),
  evaluateFlag: { enabled: undefined as boolean | undefined },
  updateSuiteMutation: vi.fn(),
  handleGenerateTests: vi.fn(),
  handleRerun: vi.fn(),
  handleCancelRun: vi.fn(),
  confirmDelete: vi.fn(async () => true),
  setSuiteToDelete: vi.fn(),
  getEffectiveSuiteServers: vi.fn((..._args: unknown[]): string[] => []),
  isDirectGuest: false,
  isAuthenticated: true,
  useQuery: vi.fn(),
  evalIterationQuota: undefined as
    | {
        used: number;
        allowed: number | null;
        resetsAt: number;
        windowKind: "day" | "month";
      }
    | undefined,
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    getAccessToken: vi.fn().mockResolvedValue("token"),
  }),
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: mocks.isAuthenticated,
    isLoading: false,
  }),
  useConvex: () => ({ query: vi.fn().mockResolvedValue([]) }),
  useQuery: (...args: unknown[]) => mocks.useQuery(...args),
  useMutation: () => vi.fn().mockResolvedValue({ _id: "stub-id" }),
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    isLoading: false,
    loadMore: vi.fn(),
  }),
}));

vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
}));

// `useEvaluateEnabled` resolves `evaluate-enabled` here. The canonical
// decision-summary read rides that same flag, so these specs can flip it.
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: () => mocks.evaluateFlag.enabled,
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: () => "light",
}));

vi.mock("@/lib/evals/generate-and-persist-tests", () => ({
  generateAndPersistEvalTests: vi.fn().mockResolvedValue({
    skippedBecauseExistingCases: false,
    createdCount: 0,
    apiReturnedTests: 0,
    createdTestCaseIds: [],
  }),
}));

vi.mock("@/hooks/use-eval-tab-context", () => ({
  useEvalTabContext: () => ({
    organizationId: "org-1",
    connectedServerNames: new Set(["server-a", "server-b"]),
    userMap: new Map(),
    canManageEvalArtifacts: false,
    // Nobody's artifacts are deletable in this fixture: not a manager, and
    // the suites under test were made by someone else.
    canDeleteArtifact: () => false,
    canDeleteRuns: false,
    availableModels: [],
  }),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({
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
    servers: {
      "server-a": { connectionStatus: "connected" },
      "server-b": { connectionStatus: "connected" },
    },
  }),
}));

vi.mock("@/lib/eval-route-url", () => ({
  useEvaluateRouteFromUrl: () => mocks.route.current,
}));

vi.mock("../evals/helpers", () => ({
  aggregateSuite: () => null,
  // EvaluateTab's `generateState` memo and the agent bridge's generate handler
  // call this to compute the effective server set. Configurable so the
  // bridge tests can give a suite servers; defaults to [] for the rest.
  getEffectiveSuiteServers: (...args: unknown[]) =>
    mocks.getEffectiveSuiteServers(...args),
  // The bridge's run resolver accepts the shortened display id.
  formatRunId: (runId: string) => runId.substring(0, 8),
}));

vi.mock("../evaluate/create-suite-navigation", () => ({
  navigatePlaygroundEvalsRoute: (...args: unknown[]) =>
    mocks.navigatePlaygroundEvalsRoute(...args),
  createPlaygroundSuiteNavigation: () => ({
    toSuiteOverview: (...args: unknown[]) => mocks.toSuiteOverview(...args),
    toRunDetail: vi.fn(),
    toTestDetail: vi.fn(),
    toTestEdit: vi.fn(),
    toSuiteEdit: vi.fn(),
  }),
}));

vi.mock("../evals/EvalTabGate", () => ({
  // Mirror the real gate's `header` slot: the Evaluate chrome and the
  // breadcrumb render there, above whichever gate state is active.
  EvalTabGate: ({
    header,
    children,
  }: {
    header?: ReactNode;
    children: ReactNode;
  }) => (
    <>
      {header}
      {children}
    </>
  ),
}));

vi.mock("../evals/ConfirmationDialogs", () => ({
  ConfirmationDialogs: () => null,
}));

vi.mock("../evals/evals-suite-list-sidebar", () => ({
  EvalsSuiteListSidebar: () => <div data-testid="suite-sidebar" />,
}));

vi.mock("../evals/use-playground-project-executions", () => ({
  usePlaygroundProjectExecutions: () => ({
    status: "ready" as const,
    cases: [],
    iterations: [],
    iterationToSuiteId: new Map<string, string>(),
  }),
}));

vi.mock("../evaluate/create-suite-page", () => ({
  CreateSuitePage: (props: Record<string, unknown>) => {
    mocks.createSuitePage(props);
    return <div data-testid="create-suite-page" />;
  },
}));

vi.mock("../evals/suite-iterations-view", () => ({
  SuiteIterationsView: (props: Record<string, unknown>) => {
    mocks.suiteIterationsView(props);
    return <div data-testid="suite-iterations-view" />;
  },
}));

vi.mock("../evals/project-runs-table", () => ({
  ProjectRunsTable: (props: Record<string, unknown>) => {
    mocks.projectRunsTable(props);
    return <div data-testid="project-runs-table" />;
  },
}));

vi.mock("../evals/use-eval-mutations", () => ({
  useEvalMutations: () => ({
    createTestSuiteMutation: mocks.createTestSuiteMutation,
    updateTestSuiteMutation: vi.fn().mockResolvedValue(undefined),
    createTestCaseMutation: vi.fn().mockResolvedValue("tc-1"),
  }),
}));

vi.mock("../evals/use-eval-handlers", () => ({
  useEvalHandlers: () => ({
    deletingSuiteId: null,
    suiteToDelete: null,
    setSuiteToDelete: mocks.setSuiteToDelete,
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
    handleRerun: mocks.handleRerun,
    handleCancelRun: mocks.handleCancelRun,
    handleDelete: vi.fn(),
    handleDeleteRun: vi.fn(),
    directDeleteRun: vi.fn().mockResolvedValue(undefined),
    directDeleteTestCase: vi.fn().mockResolvedValue(undefined),
    handleRunTestCase: vi.fn().mockResolvedValue(undefined),
    confirmDelete: mocks.confirmDelete,
    confirmDeleteRun: vi.fn(),
    confirmDeleteTestCase: vi.fn(),
  }),
}));

vi.mock("../evals/use-eval-queries", () => ({
  useEvalQueries: (...args: unknown[]) => mocks.useEvalQueries(...args),
}));

import { EvaluateTab } from "../EvaluateTab";

function makeSuiteEntry(
  serverNames: string[],
  suiteId: string,
  overrides?: {
    source?: "ui" | "sdk";
    latestRun?: { _id: string; completedAt: number } | null;
  },
) {
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
      source: overrides?.source ?? ("ui" as const),
      tags: ["explore"],
    },
    latestRun: overrides?.latestRun ?? null,
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

describe("EvaluateTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDirectGuest = false;
    mocks.isAuthenticated = true;
    // Default OFF, matching `useFeatureFlagEnabled`'s own "still loading"
    // value. Specs that care about the redesign flag opt in explicitly.
    mocks.evaluateFlag.enabled = undefined;
    mocks.evalIterationQuota = undefined;
    mocks.getEffectiveSuiteServers.mockImplementation(() => []);
    mocks.useQuery.mockImplementation((name: unknown) =>
      name === "billing:getEvalIterationQuota"
        ? mocks.evalIterationQuota
        : undefined
    );
    mocks.route.current = { type: "suite-overview", suiteId: "suite-a" };
    mocks.useEvalQueries.mockImplementation(
      ({ selectedSuiteId }: { selectedSuiteId: string | null }) =>
        makeQueryState(selectedSuiteId)
    );
  });

  it("renders from suite-driven route state without depending on an active server", () => {
    render(<EvaluateTab projectId="ws-1" />);

    expect(mocks.navigatePlaygroundEvalsRoute).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Evaluate" })).toBeNull();
    expect(screen.getByRole("button", { name: /^evaluate$/i })).toBeInTheDocument();
    expect(screen.getByText("/")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Suite suite-a", current: "page" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Switch suite/ }),
    ).toBeNull();
    expect(mocks.suiteIterationsView).toHaveBeenCalled();
    expect(
      screen.queryByRole("navigation", { name: "Evaluate view" }),
    ).toBeNull();
    expect(mocks.suiteIterationsView.mock.calls.at(-1)?.[0]).toMatchObject({
      suite: expect.objectContaining({ _id: "suite-a" }),
      projectServers: expect.arrayContaining([
        expect.objectContaining({ name: "server-a" }),
        expect.objectContaining({ name: "server-b" }),
      ]),
    });
  });

  it("keeps the bare eval list route on the suites overview instead of jumping into a suite", () => {
    mocks.route.current = { type: "list" };
    render(<EvaluateTab projectId="ws-1" />);

    expect(mocks.navigatePlaygroundEvalsRoute).not.toHaveBeenCalled();
    expect(screen.getByTestId("evals-suites-landing")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Evaluate" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "We generate cases from live discovery, or describe behaviors in chat, or import your existing tests.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Switch suite \(current: Suite suite-a\)/,
      }),
    ).toBeNull();
    expect(screen.getByTestId("evals-suites-overview")).toBeInTheDocument();
    expect(screen.getByText("Suite suite-a")).toBeInTheDocument();
    expect(screen.getByText("Suite suite-b")).toBeInTheDocument();
    expect(screen.queryByTestId("project-runs-table")).toBeNull();
    expect(screen.queryByTestId("evals-runs-landing")).toBeNull();
    expect(screen.getByRole("button", { name: /^suites$/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.queryByTestId("suite-iterations-view")).toBeNull();
  });

  /**
   * The canonical run decision summary rides `evaluate-enabled` and is
   * threaded down as a prop, so a flag-off render reaches the shared
   * `/evals` components with the read switched off — which is what keeps
   * those components' behaviour on the shipped tab unchanged.
   */
  describe("canonical decision summary flag", () => {
    it("is off for both surfaces while the flag is off", async () => {
      mocks.route.current = { type: "list" };
      const user = userEvent.setup();
      render(<EvaluateTab projectId="ws-1" />);
      await user.click(screen.getByRole("button", { name: /^runs$/i }));

      expect(mocks.projectRunsTable.mock.calls.at(-1)?.[0]).toMatchObject({
        decisionSummaryEnabled: false,
      });
    });

    it("is on for both surfaces once the flag is on", async () => {
      mocks.evaluateFlag.enabled = true;
      mocks.route.current = { type: "list" };
      const user = userEvent.setup();
      render(<EvaluateTab projectId="ws-1" />);
      await user.click(screen.getByRole("button", { name: /^runs$/i }));

      expect(mocks.projectRunsTable.mock.calls.at(-1)?.[0]).toMatchObject({
        projectId: "ws-1",
        decisionSummaryEnabled: true,
      });
    });

    it("threads the flag and the project id into the suite surface", () => {
      mocks.evaluateFlag.enabled = true;
      render(<EvaluateTab projectId="ws-1" />);

      expect(mocks.suiteIterationsView.mock.calls.at(-1)?.[0]).toMatchObject({
        // Never resolved in the browser — the tab already has it.
        projectId: "ws-1",
        evaluateDecisionSummary: true,
      });
    });

    it("leaves the suite surface's read off while the flag is off", () => {
      render(<EvaluateTab projectId="ws-1" />);

      expect(mocks.suiteIterationsView.mock.calls.at(-1)?.[0]).toMatchObject({
        evaluateDecisionSummary: false,
      });
    });
  });

  it("switches the list landing to the runs table via the header tabs", async () => {
    mocks.route.current = { type: "list" };
    const user = userEvent.setup();
    render(<EvaluateTab projectId="ws-1" />);

    await user.click(screen.getByRole("button", { name: /^runs$/i }));

    expect(screen.getByTestId("evals-runs-landing")).toBeInTheDocument();
    expect(screen.getByTestId("project-runs-table")).toBeInTheDocument();
    expect(screen.queryByTestId("evals-suites-landing")).toBeNull();
    expect(screen.getByRole("button", { name: /^runs$/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("does not auto-navigate to the most recently run suite on the list route", () => {
    mocks.route.current = { type: "list" };
    mocks.useEvalQueries.mockImplementation(() => {
      const suiteA = makeSuiteEntry(["server-a"], "suite-a");
      const suiteB = makeSuiteEntry(["server-b"], "suite-b", {
        latestRun: { _id: "run-b", completedAt: 500 },
      });
      const state = makeQueryState(null);
      return { ...state, sortedSuites: [suiteA, suiteB] };
    });

    render(<EvaluateTab projectId="ws-1" />);

    expect(mocks.navigatePlaygroundEvalsRoute).not.toHaveBeenCalled();
    expect(screen.getByTestId("evals-suites-landing")).toBeInTheDocument();
    expect(screen.getByText("Suite suite-b")).toBeInTheDocument();
  });

  it("navigates into a suite dashboard from the list overview", async () => {
    mocks.route.current = { type: "list" };
    const user = userEvent.setup();
    render(<EvaluateTab projectId="ws-1" />);

    await user.click(screen.getByText("Suite suite-a"));

    expect(mocks.navigatePlaygroundEvalsRoute).toHaveBeenCalledWith({
      type: "suite-overview",
      suiteId: "suite-a",
    });
  });

  it("shows the empty hero on the list route when there are no suites", () => {
    mocks.route.current = { type: "list" };
    mocks.useEvalQueries.mockImplementation(() => ({
      ...makeQueryState(null),
      sortedSuites: [],
      suiteOverview: [],
    }));

    render(<EvaluateTab projectId="ws-1" />);

    expect(mocks.navigatePlaygroundEvalsRoute).not.toHaveBeenCalled();
    expect(screen.getByTestId("evals-empty-hero")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create suite from server-a" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("evals-suites-landing")).toBeNull();
    expect(screen.queryByTestId("project-runs-table")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Switch suite/ }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: /^suites$/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("shows the runs table from the empty landing when Runs is selected", async () => {
    mocks.route.current = { type: "list" };
    mocks.useEvalQueries.mockImplementation(() => ({
      ...makeQueryState(null),
      sortedSuites: [],
      suiteOverview: [],
    }));

    const user = userEvent.setup();
    render(<EvaluateTab projectId="ws-1" />);

    await user.click(screen.getByRole("button", { name: /^runs$/i }));

    expect(screen.queryByTestId("evals-empty-hero")).toBeNull();
    expect(screen.getByTestId("evals-runs-landing")).toBeInTheDocument();
    expect(screen.getByTestId("project-runs-table")).toBeInTheDocument();
  });

  it("opens create-suite from an empty-hero server card with that server prefilled", async () => {
    mocks.route.current = { type: "list" };
    mocks.useEvalQueries.mockImplementation(() => ({
      ...makeQueryState(null),
      sortedSuites: [],
      suiteOverview: [],
    }));

    const user = userEvent.setup();
    const view = render(<EvaluateTab projectId="ws-1" />);

    await user.click(
      screen.getByRole("button", { name: "Create suite from server-a" }),
    );

    expect(mocks.navigatePlaygroundEvalsRoute).toHaveBeenCalledWith({
      type: "create",
    });

    mocks.route.current = { type: "create" };
    view.rerender(<EvaluateTab projectId="ws-1" />);

    expect(screen.getByTestId("create-suite-page")).toBeInTheDocument();
    expect(screen.queryByTestId("evals-empty-hero")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Evaluate" })).toBeNull();
    await waitFor(() => {
      expect(mocks.createSuitePage.mock.calls.at(-1)?.[0]).toMatchObject({
        initialName: "server-a",
        initialServerId: "srv-a",
      });
    });
  });

  it("renders the create-suite page instead of the landing header on /evaluate/create", () => {
    mocks.route.current = { type: "create" };

    render(<EvaluateTab projectId="ws-1" />);

    expect(screen.getByTestId("create-suite-page")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Evaluate" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^create suite$/i }),
    ).toBeNull();
    expect(screen.queryByTestId("evals-suites-landing")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders sdk-created suites instead of redirecting them away", () => {
    mocks.route.current = { type: "suite-overview", suiteId: "suite-sdk" };
    mocks.useEvalQueries.mockImplementation(
      ({ selectedSuiteId }: { selectedSuiteId: string | null }) => {
        const sdkEntry = makeSuiteEntry(["server-a"], "suite-sdk", {
          source: "sdk",
        });
        const state = makeQueryState(selectedSuiteId);
        return {
          ...state,
          sortedSuites: [sdkEntry],
          selectedSuiteEntry: selectedSuiteId === "suite-sdk" ? sdkEntry : null,
          selectedSuite:
            selectedSuiteId === "suite-sdk" ? sdkEntry.suite : null,
          suiteDetails:
            selectedSuiteId === "suite-sdk"
              ? { testCases: [], iterations: [] }
              : undefined,
          suiteRuns: selectedSuiteId === "suite-sdk" ? [] : undefined,
        };
      }
    );

    render(<EvaluateTab projectId="ws-1" />);

    expect(mocks.navigatePlaygroundEvalsRoute).not.toHaveBeenCalled();
    expect(mocks.suiteIterationsView).toHaveBeenCalled();
    expect(mocks.suiteIterationsView.mock.calls.at(-1)?.[0]).toMatchObject({
      suite: expect.objectContaining({ _id: "suite-sdk", source: "sdk" }),
    });
  });

  it("navigates to the suites list from the Evaluate crumb", async () => {
    const user = userEvent.setup();
    render(<EvaluateTab projectId="ws-1" />);
    expect(mocks.navigatePlaygroundEvalsRoute).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^evaluate$/i }));

    expect(mocks.navigatePlaygroundEvalsRoute).toHaveBeenCalledWith({
      type: "list",
    });
  });

  it("keeps Evaluate / suite-name on test detail and goes to the list", async () => {
    mocks.route.current = {
      type: "test-detail",
      suiteId: "suite-a",
      testId: "tc-1",
    };
    mocks.useEvalQueries.mockImplementation(
      ({ selectedSuiteId }: { selectedSuiteId: string | null }) =>
        makeQueryState(selectedSuiteId),
    );

    const user = userEvent.setup();
    render(<EvaluateTab projectId="ws-1" />);

    expect(screen.queryByRole("heading", { name: "Evaluate" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /^create suite$/i }),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Test case", current: "page" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Switch suite/ }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "Suite suite-a" }));
    expect(mocks.toSuiteOverview).toHaveBeenCalledWith("suite-a");

    await user.click(screen.getByRole("button", { name: /^evaluate$/i }));

    expect(mocks.navigatePlaygroundEvalsRoute).toHaveBeenCalledWith({
      type: "list",
    });
  });

  it("redirects invalid suite routes back to the eval list", async () => {
    mocks.route.current = { type: "suite-overview", suiteId: "missing-suite" };

    render(<EvaluateTab projectId="ws-1" />);

    await waitFor(() => {
      expect(mocks.navigatePlaygroundEvalsRoute).toHaveBeenCalledWith(
        { type: "list" },
        { replace: true }
      );
    });
  });

  it("passes eval iteration limit disabled state into the suite view", () => {
    mocks.evalIterationQuota = {
      used: 25,
      allowed: 25,
      resetsAt: Date.UTC(2026, 5, 2),
      windowKind: "day",
    };

    render(<EvaluateTab projectId="ws-1" />);

    expect(screen.queryByText(/eval iterations/i)).not.toBeInTheDocument();
    expect(mocks.suiteIterationsView.mock.calls.at(-1)?.[0]).toMatchObject({
      evalRunsDisabledReason: expect.stringMatching(
        /^Eval iteration limit reached\. Resets /
      ),
    });
  });

  it("fetches eval iteration quota for guest org sessions", () => {
    mocks.isAuthenticated = false;

    render(<EvaluateTab projectId="ws-1" />);

    expect(mocks.useQuery).toHaveBeenCalledWith(
      "billing:getEvalIterationQuota",
      { organizationId: "org-1" }
    );
  });

  it("shows the generic error fallback when the suites overview query throws", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      mocks.useEvalQueries.mockImplementation(() => {
        throw new Error(
          "[CONVEX Q(testSuites:getTestSuitesOverview)] [Request ID: test] Server Error"
        );
      });

      render(<EvaluateTab projectId="project-1" />);

      expect(screen.getByText("Could not load Testing")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Try again" })
      ).toBeInTheDocument();
      expect(screen.queryByTestId("suite-sidebar")).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });

  describe("agent bridge handlers", () => {
    let commandSeq = 0;
    async function dispatch(command: Omit<InspectorCommand, "id">) {
      commandSeq += 1;
      let response!: InspectorCommandResponse;
      // Handlers call the component's own callbacks and setState, so the
      // dispatch is a React state update and belongs inside act().
      await act(async () => {
        response = await executeInspectorCommand({
          ...command,
          id: `evals-bridge-${commandSeq}`,
        } as InspectorCommand);
      });
      return response;
    }

    it("runEvalSuite resolves the suite and starts the run through the quota-gated wrapper", async () => {
      render(<EvaluateTab projectId="ws-1" />);

      const response = await dispatch({
        type: "runEvalSuite",
        payload: { suite: "Suite suite-b" },
      });

      expect(response).toMatchObject({
        status: "success",
        result: { status: "run_requested", suiteId: "suite-b" },
      });
      expect(mocks.handleRerun).toHaveBeenCalledWith(
        expect.objectContaining({ _id: "suite-b" }),
      );
    });

    it("runEvalSuite refuses when the eval iteration quota is exhausted — never a bypass", async () => {
      mocks.evalIterationQuota = {
        used: 25,
        allowed: 25,
        resetsAt: Date.UTC(2026, 5, 2),
        windowKind: "day",
      };
      render(<EvaluateTab projectId="ws-1" />);

      const response = await dispatch({
        type: "runEvalSuite",
        payload: { suite: "Suite suite-a" },
      });

      expect(response).toMatchObject({
        status: "error",
        error: { code: "execution_failed" },
      });
      const message =
        response.status === "error" ? response.error.message : "";
      expect(message).toMatch(/Eval iteration limit reached/);
      expect(message).toMatch(/25\/25 eval iterations used/);
      // The raw un-gated run path must not have been touched.
      expect(mocks.handleRerun).not.toHaveBeenCalled();
    });

    it("rejects an unknown suite as invalid_request without touching any callback", async () => {
      render(<EvaluateTab projectId="ws-1" />);

      const response = await dispatch({
        type: "runEvalSuite",
        payload: { suite: "Not A Suite" },
      });

      expect(response).toMatchObject({
        status: "error",
        error: { code: "invalid_request" },
      });
      expect(mocks.handleRerun).not.toHaveBeenCalled();
    });

    it("asks for the suite id when a name matches more than one suite", async () => {
      mocks.useEvalQueries.mockImplementation(
        ({ selectedSuiteId }: { selectedSuiteId: string | null }) => {
          const first = makeSuiteEntry(["server-a"], "suite-a");
          const second = makeSuiteEntry(["server-a"], "suite-dup");
          second.suite.name = first.suite.name;
          const state = makeQueryState(selectedSuiteId);
          return { ...state, sortedSuites: [first, second] };
        },
      );
      render(<EvaluateTab projectId="ws-1" />);

      const response = await dispatch({
        type: "deleteEvalSuite",
        payload: { suite: "Suite suite-a" },
      });

      expect(response).toMatchObject({
        status: "error",
        error: { code: "invalid_request" },
      });
      expect(response.status === "error" && response.error.message).toMatch(
        /suite id/i,
      );
      expect(mocks.setSuiteToDelete).not.toHaveBeenCalled();
      expect(mocks.confirmDelete).not.toHaveBeenCalled();
    });

    it("deleteEvalSuite stages via setSuiteToDelete and commits via confirmDelete", async () => {
      render(<EvaluateTab projectId="ws-1" />);

      const response = await dispatch({
        type: "deleteEvalSuite",
        payload: { suite: "suite-b" },
      });

      expect(response).toMatchObject({
        status: "success",
        result: { status: "deleted", suiteId: "suite-b" },
      });
      expect(mocks.setSuiteToDelete).toHaveBeenCalledWith(
        expect.objectContaining({ _id: "suite-b" }),
      );
      expect(mocks.confirmDelete).toHaveBeenCalledTimes(1);
      // Staged before committed, and the staging dialog is closed after.
      expect(
        mocks.setSuiteToDelete.mock.invocationCallOrder[0],
      ).toBeLessThan(mocks.confirmDelete.mock.invocationCallOrder[0]);
      expect(mocks.setSuiteToDelete).toHaveBeenLastCalledWith(null);
    });

    it("deleteEvalSuite propagates a failed delete as an error", async () => {
      mocks.confirmDelete.mockResolvedValueOnce(false);
      render(<EvaluateTab projectId="ws-1" />);

      const response = await dispatch({
        type: "deleteEvalSuite",
        payload: { suite: "suite-b" },
      });

      // confirmDelete swallows the backend error to a toast but now returns
      // false — the agent must see a real failure, not a claimed deletion.
      expect(response).toMatchObject({
        status: "error",
        error: { code: "execution_failed" },
      });
    });

    it("cancelEvalRun cancels visible running runs and reports finished ones instead", async () => {
      mocks.useEvalQueries.mockImplementation(
        ({ selectedSuiteId }: { selectedSuiteId: string | null }) => ({
          ...makeQueryState(selectedSuiteId),
          runsForSelectedSuite: [
            { _id: "run-live-1", status: "running" },
            { _id: "run-done-1", status: "completed" },
          ],
        }),
      );
      render(<EvaluateTab projectId="ws-1" />);

      const cancelled = await dispatch({
        type: "cancelEvalRun",
        payload: { runId: "run-live-1" },
      });
      expect(cancelled).toMatchObject({
        status: "success",
        result: { status: "cancel_requested", runId: "run-live-1" },
      });
      expect(mocks.handleCancelRun).toHaveBeenCalledWith("run-live-1");

      mocks.handleCancelRun.mockClear();
      const finished = await dispatch({
        type: "cancelEvalRun",
        payload: { runId: "run-done-1" },
      });
      expect(finished).toMatchObject({
        status: "success",
        result: { status: "already_finished", runId: "run-done-1" },
      });
      expect(mocks.handleCancelRun).not.toHaveBeenCalled();

      const unknown = await dispatch({
        type: "cancelEvalRun",
        payload: { runId: "run-nope" },
      });
      expect(unknown).toMatchObject({
        status: "error",
        error: { code: "invalid_request" },
      });
    });

    it("generateEvalTests routes through the button's generation path with the suite's servers", async () => {
      mocks.getEffectiveSuiteServers.mockImplementation(() => ["server-a"]);
      render(<EvaluateTab projectId="ws-1" />);

      const response = await dispatch({
        type: "generateEvalTests",
        payload: { suite: "Suite suite-a" },
      });

      expect(response).toMatchObject({
        status: "success",
        result: { status: "generation_started", suiteId: "suite-a" },
      });
      // Fire-and-forget: the same handleGenerateTests callback the Generate
      // button uses, with the suite's effective servers.
      await waitFor(() => {
        expect(mocks.handleGenerateTests).toHaveBeenCalledWith(
          "suite-a",
          ["server-a"],
          expect.objectContaining({ generationOptions: expect.anything() }),
        );
      });
    });

    it("generateEvalTests rejects a suite with no servers attached", async () => {
      render(<EvaluateTab projectId="ws-1" />);

      const response = await dispatch({
        type: "generateEvalTests",
        payload: { suite: "Suite suite-a" },
      });

      expect(response).toMatchObject({
        status: "error",
        error: { code: "invalid_request" },
      });
      expect(mocks.handleGenerateTests).not.toHaveBeenCalled();
    });

    it("openEvalSuiteForm opens the create page with a name-only prefill — no suite is created", async () => {
      render(<EvaluateTab projectId="ws-1" />);

      const response = await dispatch({
        type: "openEvalSuiteForm",
        payload: { name: "Asana smoke tests" },
      });

      expect(response).toMatchObject({
        status: "success",
        result: { status: "form_opened", prefilledName: "Asana smoke tests" },
      });
      expect(mocks.navigatePlaygroundEvalsRoute).toHaveBeenCalledWith({
        type: "create",
      });
      expect(mocks.createTestSuiteMutation).not.toHaveBeenCalled();
    });

    it("refuses every command as unsupported_in_mode while the tab gate blocks the screen", async () => {
      mocks.isAuthenticated = false;
      render(<EvaluateTab projectId="ws-1" />);

      const response = await dispatch({
        type: "runEvalSuite",
        payload: { suite: "Suite suite-a" },
      });

      expect(response).toMatchObject({
        status: "error",
        error: { code: "unsupported_in_mode" },
      });
      expect(mocks.handleRerun).not.toHaveBeenCalled();
    });

    it("snapshot reports redacted suite state — names, ids, quota, and counters only", async () => {
      mocks.evalIterationQuota = {
        used: 3,
        allowed: 25,
        resetsAt: Date.UTC(2026, 5, 2),
        windowKind: "day",
      };
      render(<EvaluateTab projectId="ws-1" />);

      const snapshot = await readSurfaceSnapshot("evals");
      expect(snapshot).toMatchObject({
        ok: true,
        data: {
          view: "suite-overview",
          quota: {
            iterationsUsed: 3,
            iterationsAllowed: 25,
            windowKind: "day",
          },
          selectedSuite: expect.objectContaining({
            id: "suite-a",
            name: "Suite suite-a",
          }),
          totalSuites: 2,
          suites: [
            expect.objectContaining({ id: "suite-a", name: "Suite suite-a" }),
            expect.objectContaining({ id: "suite-b", name: "Suite suite-b" }),
          ],
          isGeneratingTests: false,
        },
      });
    });
  });
});
