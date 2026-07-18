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
  createTestSuiteMutation: vi.fn(),
  suiteIterationsView: vi.fn(),
  updateSuiteMutation: vi.fn(),
  handleGenerateTests: vi.fn(),
  handleRerun: vi.fn(),
  handleCancelRun: vi.fn(),
  confirmDelete: vi.fn(),
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
}));

vi.mock("posthog-js", () => ({
  default: { capture: vi.fn() },
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
    canDeleteSuite: false,
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
  useEvalsRouteFromUrl: () => mocks.route.current,
}));

vi.mock("../evals/helpers", () => ({
  aggregateSuite: () => null,
  // EvalsTab's `generateState` memo and the agent bridge's generate handler
  // call this to compute the effective server set. Configurable so the
  // bridge tests can give a suite servers; defaults to [] for the rest.
  getEffectiveSuiteServers: (...args: unknown[]) =>
    mocks.getEffectiveSuiteServers(...args),
  // The bridge's run resolver accepts the shortened display id.
  formatRunId: (runId: string) => runId.substring(0, 8),
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

vi.mock("../evals/use-playground-project-executions", () => ({
  usePlaygroundProjectExecutions: () => ({
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

import { EvalsTab } from "../EvalsTab";

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

describe("EvalsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDirectGuest = false;
    mocks.isAuthenticated = true;
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
    render(<EvalsTab projectId="ws-1" />);

    expect(mocks.navigatePlaygroundEvalsRoute).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: /Switch suite \(current: Suite suite-a\)/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("Suite suite-a")).toBeInTheDocument();
    expect(mocks.suiteIterationsView).toHaveBeenCalled();
    expect(mocks.suiteIterationsView.mock.calls.at(-1)?.[0]).toMatchObject({
      suite: expect.objectContaining({ _id: "suite-a" }),
      projectServers: expect.arrayContaining([
        expect.objectContaining({ name: "server-a" }),
        expect.objectContaining({ name: "server-b" }),
      ]),
    });
  });

  it("redirects the bare eval list route into the most recent suite", async () => {
    mocks.route.current = { type: "list" };
    render(<EvalsTab projectId="ws-1" />);

    await waitFor(() => {
      expect(mocks.navigatePlaygroundEvalsRoute).toHaveBeenCalledWith(
        { type: "suite-overview", suiteId: "suite-a" },
        { replace: true }
      );
    });
    expect(screen.queryByTestId("suite-sidebar")).toBeNull();
  });

  it("redirects the bare eval list route into the most recently run suite", async () => {
    mocks.route.current = { type: "list" };
    mocks.useEvalQueries.mockImplementation(() => {
      const suiteA = makeSuiteEntry(["server-a"], "suite-a");
      const suiteB = makeSuiteEntry(["server-b"], "suite-b", {
        latestRun: { _id: "run-b", completedAt: 500 },
      });
      const state = makeQueryState(null);
      return { ...state, sortedSuites: [suiteA, suiteB] };
    });

    render(<EvalsTab projectId="ws-1" />);

    await waitFor(() => {
      expect(mocks.navigatePlaygroundEvalsRoute).toHaveBeenCalledWith(
        { type: "suite-overview", suiteId: "suite-b" },
        { replace: true }
      );
    });
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

    render(<EvalsTab projectId="ws-1" />);

    expect(mocks.navigatePlaygroundEvalsRoute).not.toHaveBeenCalled();
    expect(mocks.suiteIterationsView).toHaveBeenCalled();
    expect(mocks.suiteIterationsView.mock.calls.at(-1)?.[0]).toMatchObject({
      suite: expect.objectContaining({ _id: "suite-sdk", source: "sdk" }),
    });
  });

  it("switches suites from the breadcrumb dropdown", async () => {
    const user = userEvent.setup();
    render(<EvalsTab projectId="ws-1" />);
    expect(mocks.navigatePlaygroundEvalsRoute).not.toHaveBeenCalled();

    // Open the switcher from Suites and pick another suite.
    await user.click(
      screen.getByRole("button", {
        name: /Switch suite \(current: Suite suite-a\)/,
      }),
    );
    await user.click(screen.getByRole("button", { name: /Suite suite-b/ }));

    expect(mocks.navigatePlaygroundEvalsRoute).toHaveBeenCalledWith({
      type: "suite-overview",
      suiteId: "suite-b",
    });
  });

  it("navigates back to suite overview from the breadcrumb on test detail", async () => {
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
    render(<EvalsTab projectId="ws-1" />);

    await user.click(screen.getByRole("button", { name: "Suite suite-a" }));

    expect(mocks.navigatePlaygroundEvalsRoute).toHaveBeenCalledWith({
      type: "suite-overview",
      suiteId: "suite-a",
    });
  });

  it("redirects invalid suite routes back to the eval list", async () => {
    mocks.route.current = { type: "suite-overview", suiteId: "missing-suite" };

    render(<EvalsTab projectId="ws-1" />);

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

    render(<EvalsTab projectId="ws-1" />);

    expect(screen.queryByText(/eval iterations/i)).not.toBeInTheDocument();
    expect(mocks.suiteIterationsView.mock.calls.at(-1)?.[0]).toMatchObject({
      evalRunsDisabledReason: expect.stringMatching(
        /^Eval iteration limit reached\. Resets /
      ),
    });
  });

  it("fetches eval iteration quota for guest org sessions", () => {
    mocks.isAuthenticated = false;

    render(<EvalsTab projectId="ws-1" />);

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

      render(<EvalsTab projectId="project-1" />);

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
      render(<EvalsTab projectId="ws-1" />);

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
      render(<EvalsTab projectId="ws-1" />);

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
      render(<EvalsTab projectId="ws-1" />);

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
      render(<EvalsTab projectId="ws-1" />);

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
      render(<EvalsTab projectId="ws-1" />);

      const response = await dispatch({
        type: "deleteEvalSuite",
        payload: { suite: "suite-b" },
      });

      expect(response).toMatchObject({
        status: "success",
        result: { status: "delete_requested", suiteId: "suite-b" },
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
      render(<EvalsTab projectId="ws-1" />);

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
      render(<EvalsTab projectId="ws-1" />);

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
      render(<EvalsTab projectId="ws-1" />);

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

    it("openEvalSuiteForm opens the create dialog with a name-only prefill — no suite is created", async () => {
      render(<EvalsTab projectId="ws-1" />);

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
      render(<EvalsTab projectId="ws-1" />);

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
      render(<EvalsTab projectId="ws-1" />);

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
