/**
 * Walks the per-layer Evaluate pages through the real tab and a real data
 * router, with evaluate-nav-enabled on: every step clicks a real control, and
 * each page must replace the last, show its trail and Back, and then stop
 * rendering. Mocks stop at the data hooks the pages read.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import type { FunctionReference } from "convex/server";
import type { NavRunOptions } from "../evaluate/nav-run/use-nav-run-links";
import { HOW_SUITES_WORK_SEEN_KEY } from "../evaluate/how-suites-work/how-suites-work-seen";
import {
  CASE_TITLE,
  COPY_SUITE_ID,
  COPY_SUITE_NAME,
  CI_SUITE_ID,
  FIRST_ITERATION_ID,
  PROJECT_ID,
  SUITE_ID,
  SUITE_NAME,
  projectUrl,
} from "./evaluate-nav-flow-fixtures";
import {
  DECISION_READ_GUARD,
  EVALUATE_ROUTE_PATHS,
  clickBack,
  clickCrumb,
  expectPage,
  renderEvaluateApp,
  step,
  type FlowApp,
  type PageExpectation,
} from "./evaluate-nav-flow-harness";

const mocks = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  });
  return {
    track: vi.fn(),
    toast,
    copyMutation: vi.fn(),
    decisionReads: 0,
    decisionRunIds: [] as string[],
    flagListeners: new Set<() => void>(),
    // Hooks below hand back these objects, never a fresh one per render,
    // as the real hooks do for unchanged inputs.
    mutations: new Map<string, ReturnType<typeof vi.fn>>(),
    convex: { query: vi.fn(async () => []) },
    action: vi.fn(),
    paginated: {
      results: [],
      status: "Exhausted",
      isLoading: false,
      loadMore: vi.fn(),
    },
    appState: {
      servers: {
        "server-a": { connectionStatus: "connected" },
      },
    },
    tabContext: {
      organizationId: "org-1",
      connectedServerNames: new Set(["server-a"]),
      userMap: new Map(),
      canManageEvalArtifacts: true,
      canDeleteArtifact: () => true,
      canDeleteRuns: true,
      availableModels: [],
    },
    projectServers: {
      servers: [{ _id: "srv-a", name: "server-a", transportType: "http" }],
      isLoading: false,
    },
    hostList: { hosts: [], isLoading: false },
    executions: {
      status: "ready" as const,
      cases: [],
      iterations: [],
      iterationToSuiteId: new Map<string, string>(),
    },
    evalMutations: {
      createTestSuiteMutation: vi.fn(),
      updateTestSuiteMutation: vi.fn(),
      createTestCaseMutation: vi.fn(),
    },
    handlers: {
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
      directDeleteRun: vi.fn(),
      directDeleteTestCase: vi.fn(),
      handleRunTestCase: vi.fn(),
      confirmDelete: vi.fn(),
      confirmDeleteRun: vi.fn(),
      confirmDeleteTestCase: vi.fn(),
    },
    environments: [],
    availableModels: { availableModels: [] },
    capabilities: { state: "ready", capabilities: null },
    configLock: {
      capabilities: null,
      capabilitiesState: "ready",
      configLocked: false,
      editingDisabled: false,
    },
    groundedness: { result: null, pending: false },
    compare: { status: "disabled", dto: null, errorKind: null },
    caseTools: [],
    runGroups: new WeakMap<object, unknown>(),
  };
});

vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
// Only the per-layer pages' flag is on, read the way PostHog's hook reads it.
vi.mock("posthog-js/react", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    mocks.flagListeners.add(listener);
    return () => mocks.flagListeners.delete(listener);
  };
  return {
    useFeatureFlagEnabled: (name: string) =>
      useSyncExternalStore(subscribe, () => name === "evaluate-nav-enabled"),
  };
});

vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  const { answerQuery } = await import("./evaluate-nav-flow-fixtures");
  const nameOf = (ref: unknown) =>
    typeof ref === "string"
      ? ref
      : getFunctionName(ref as FunctionReference<"query">);
  const mutationFor = (name: string) => {
    if (name === "testCaseCopy:copyTestCaseToSuite") return mocks.copyMutation;
    const known = mocks.mutations.get(name);
    if (known) return known;
    const created = vi.fn(async () => ({ _id: "stub-id" }));
    mocks.mutations.set(name, created);
    return created;
  };
  return (await import("@/test/mocks/convex-use-queries")).withUseQueries({
    useQuery: (ref: unknown, args: unknown) => answerQuery(nameOf(ref), args),
    useMutation: (ref: unknown) => mutationFor(nameOf(ref)),
    useAction: () => mocks.action,
    useConvex: () => mocks.convex,
    useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
    usePaginatedQuery: () => mocks.paginated,
  });
});

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { id: "user-1" }, getAccessToken: vi.fn() }),
}));
vi.mock("@/hooks/useClients", () => ({ useHostList: () => mocks.hostList }));
vi.mock(
  "@/stores/preferences/preferences-provider",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/stores/preferences/preferences-provider")
    >()),
    usePreferencesStore: () => "light",
  }),
);
vi.mock("@/lib/evals/generate-and-persist-tests", () => ({
  generateAndPersistEvalTests: vi.fn(),
}));
vi.mock("@/hooks/use-eval-tab-context", () => ({
  useEvalTabContext: () => mocks.tabContext,
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => mocks.projectServers,
}));
vi.mock("@/hooks/use-is-direct-guest", () => ({
  useIsDirectGuest: () => false,
}));
vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => mocks.appState,
  useOptionalSharedAppState: () => mocks.appState,
}));
vi.mock("../evals/helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../evals/helpers")>()),
  aggregateSuite: () => null,
}));
vi.mock("../evals/ConfirmationDialogs", () => ({
  ConfirmationDialogs: () => null,
}));
vi.mock("../evals/evals-suite-list-sidebar", () => ({
  EvalsSuiteListSidebar: () => <div data-testid="suite-sidebar" />,
}));
vi.mock("../evals/use-playground-project-executions", () => ({
  usePlaygroundProjectExecutions: () => mocks.executions,
}));
vi.mock("../evaluate/create-suite-page", () => ({
  CreateSuitePage: () => <div data-testid="create-suite-page" />,
}));
vi.mock("../evals/suite-iterations-view", () => ({
  SuiteIterationsView: () => <div data-testid="suite-iterations-view" />,
}));
vi.mock("../evals/use-eval-mutations", () => ({
  useEvalMutations: () => mocks.evalMutations,
}));
vi.mock("../evals/use-eval-handlers", () => ({
  useEvalHandlers: () => mocks.handlers,
}));
vi.mock("../evals/use-eval-queries", async () => {
  const { evalQueriesFor } = await import("./evaluate-nav-flow-fixtures");
  return {
    useEvalQueries: (args: { selectedSuiteId: string | null }) =>
      evalQueriesFor(args.selectedSuiteId),
  };
});

// Page leaf hooks.
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => mocks.environments,
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => true,
}));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => mocks.availableModels,
}));
vi.mock("@/hooks/use-actor-can-query", () => ({
  useActorCanQuery: () => true,
}));
vi.mock("@/hooks/use-suite-capabilities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-suite-capabilities")>()),
  useSuiteCapabilities: () => mocks.capabilities,
}));
vi.mock("@/hooks/useScheduledEvalsEnabled", () => ({
  useScheduledEvalsEnabled: () => false,
}));
vi.mock("@/hooks/useSandboxImagesEnabled", () => ({
  useSandboxImagesEnabled: () => false,
}));
vi.mock("@/hooks/use-environment-capabilities", () => ({
  useEnvironmentCapabilities: () => null,
}));
vi.mock("@/hooks/use-eval-run-decision-summary", async (importOriginal) => {
  const { decisionDiagnosticsFor } =
    await import("./evaluate-nav-flow-fixtures");
  return {
    ...(await importOriginal<
      typeof import("@/hooks/use-eval-run-decision-summary")
    >()),
    // A new array of the same store items on every read, as the real read
    // does. A render loop would otherwise hang the test rather than fail it.
    useEvalRunDecisionDetail: ({ runId }: { runId: string | null }) => {
      mocks.decisionReads += 1;
      if (mocks.decisionReads > DECISION_READ_GUARD)
        throw new Error(
          `render loop: decision read ${DECISION_READ_GUARD} times`,
        );
      if (runId) mocks.decisionRunIds.push(runId);
      return {
        status: "ready",
        summary: null,
        diagnostics: decisionDiagnosticsFor(runId ?? ""),
      };
    },
  };
});
vi.mock("@/hooks/use-eval-run-iteration-chains", async () => {
  const { iterationChainsFor } = await import("./evaluate-nav-flow-fixtures");
  return {
    useEvalRunIterationChains: ({ run }: { run: { _id: string } | null }) =>
      iterationChainsFor(run?._id ?? ""),
  };
});
vi.mock("@/components/evals/use-selected-run", async () => {
  const { selectedRunFor } = await import("./evaluate-nav-flow-fixtures");
  return {
    useSelectedRun: (_suiteId: string, runId: string | null) =>
      selectedRunFor(runId),
  };
});
vi.mock("@/components/evals/use-runs-iterations", async (importOriginal) => {
  const { runsIterationsFor } = await import("./evaluate-nav-flow-fixtures");
  return {
    ...(await importOriginal<
      typeof import("@/components/evals/use-runs-iterations")
    >()),
    useRunsIterations: (runIds: readonly string[]) => runsIterationsFor(runIds),
  };
});
vi.mock("@/components/evals/use-run-group-summaries", () => ({
  useRunGroupSummaries: (_suiteId: string, runs: object) => {
    const known = mocks.runGroups.get(runs);
    if (known) return known;
    const answer = { runs, loadGroup: vi.fn(async () => runs) };
    mocks.runGroups.set(runs, answer);
    return answer;
  },
}));
vi.mock("@/components/evals/use-suite-config-lock", () => ({
  useSuiteConfigLock: () => mocks.configLock,
}));
vi.mock("@/components/evals/use-groundedness", () => ({
  useGroundedness: () => mocks.groundedness,
}));
vi.mock("@/components/billing/SharedSettingsGate", () => ({
  SharedSettingsGate: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("../evaluate/use-eval-run-compare", () => ({
  useEvalRunCompare: () => mocks.compare,
}));
vi.mock("../evaluate/case-steps/use-case-tools", () => ({
  useCaseTools: () => mocks.caseTools,
}));
vi.mock("../evaluate/test-run/use-test-run-data", async (importOriginal) => {
  const { testRunDataFor } = await import("./evaluate-nav-flow-fixtures");
  return {
    ...(await importOriginal<
      typeof import("../evaluate/test-run/use-test-run-data")
    >()),
    useTestRunData: (ids: {
      suiteId: string;
      runId: string;
      testCaseId: string;
    }) => testRunDataFor(ids),
  };
});
vi.mock("@/lib/analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics")>()),
  track: mocks.track,
}));
vi.mock("@/lib/toast", () => ({ toast: mocks.toast }));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: mocks.toast,
}));

// Heavy bodies off the navigation path. A stub that hosts a navigation
// control calls the page's own callback; none navigates itself.
vi.mock("../evals/project-runs-table", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../evals/project-runs-table")>()),
  ProjectRunsTable: () => <div data-testid="project-runs-table" />,
}));
vi.mock("../evaluate/suite-list-run-review", () => ({
  SuiteListRunReview: () => <div data-testid="suite-list-run-review" />,
}));
vi.mock("../evaluate/suite-run-matrix", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../evaluate/suite-run-matrix")>()),
  ConfiguredSuiteRunReview: () => <div data-testid="suite-run-matrix" />,
}));
vi.mock("../evals/eval-export-modal", () => ({
  EvalExportModal: () => null,
}));
vi.mock("../evaluate/evaluate-run-content", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../evaluate/evaluate-run-content")
  >()),
  EvaluateRunContent: (props: { nav?: NavRunOptions }) => (
    <div data-testid="nav-run-content-stub">
      <button
        type="button"
        onClick={() => props.nav?.openTestRun("case-sketch", null)}
      >
        Open test run case-sketch
      </button>
    </div>
  ),
}));
vi.mock("../evals/suite-settings-fields", () => ({
  SuiteSettingsFields: () => <div data-testid="suite-settings-fields" />,
}));
vi.mock("../evals/suite-default-evaluators-section", () => ({
  SuiteDefaultEvaluatorsSection: () => (
    <div data-testid="suite-default-evaluators" />
  ),
}));
vi.mock("../evaluate/case-workspace/case-checks-page", () => ({
  CaseChecksPage: () => <div data-testid="case-checks-page" />,
}));
vi.mock("../evaluate/suite-run-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../evaluate/suite-run-review")>()),
  SuiteRunReview: () => <div data-testid="suite-run-review" />,
}));
vi.mock("../evaluate/test-run/iteration-evidence", () => ({
  IterationEvidence: () => <div data-testid="iteration-evidence" />,
}));

const SUITE_PATH = `/evaluate/suite/${SUITE_ID}`;
const suiteUrl = (rest = "") => projectUrl(`${SUITE_PATH}${rest}`);
const RUN_PATH = "/runs/run-a";
const TEST_RUN_PATH = `${RUN_PATH}/cases/case-sketch`;

const SETTINGS_TRAIL = ["Evaluate", SUITE_NAME, "Suite settings"];
const RUN_TRAIL = ["Evaluate", SUITE_NAME, "Run #4"];
const TEST_RUN_TRAIL = [...RUN_TRAIL, CASE_TITLE];

/** Table P: each page's url, marker, trail and Back when loaded directly. */
const PAGES = {
  suites: {
    url: projectUrl("/evaluate"),
    marker: "nav-suite-overview",
    crumbs: [],
    back: null,
  },
  runs: {
    url: projectUrl("/evaluate/runs"),
    marker: "project-runs-table",
    crumbs: [],
    back: null,
  },
  suite: {
    url: suiteUrl(),
    marker: "nav-suite-page",
    crumbs: ["Evaluate", SUITE_NAME],
    back: null,
  },
  settings: {
    url: suiteUrl("/settings"),
    marker: "suite-settings-heading",
    crumbs: SETTINGS_TRAIL,
    back: "Back to suite",
  },
  cases: {
    url: suiteUrl("/settings/cases"),
    marker: "suite-settings-test-cases",
    crumbs: SETTINGS_TRAIL,
    back: "Back to suite",
  },
  evaluators: {
    url: suiteUrl("/settings/evaluators"),
    marker: "suite-default-evaluators",
    crumbs: SETTINGS_TRAIL,
    back: "Back to suite",
  },
  newCase: {
    url: suiteUrl("/settings/cases/new"),
    marker: "case-steps-editor",
    crumbs: [...SETTINGS_TRAIL, "New case"],
    back: null,
  },
  testCase: {
    url: suiteUrl("/settings/cases/case-sketch"),
    marker: "case-steps-editor",
    crumbs: [...SETTINGS_TRAIL, CASE_TITLE],
    back: "Back to suite settings",
  },
  caseEvaluators: {
    url: suiteUrl("/settings/cases/case-sketch/evaluators"),
    marker: "case-checks-page",
    crumbs: [...SETTINGS_TRAIL, CASE_TITLE, "Test Case Evaluators"],
    back: null,
  },
  suiteRun: {
    url: suiteUrl(RUN_PATH),
    marker: "nav-run-page",
    crumbs: RUN_TRAIL,
    back: "Back to suite",
  },
  testRun: {
    url: suiteUrl(TEST_RUN_PATH),
    marker: "nav-test-run",
    crumbs: TEST_RUN_TRAIL,
    back: "Back to Run #4",
  },
  edit: {
    url: suiteUrl(`${TEST_RUN_PATH}/edit`),
    marker: "case-steps-editor",
    crumbs: [...TEST_RUN_TRAIL, "Edit Test Case"],
    back: "Back to test run",
  },
  iteration: {
    url: suiteUrl(`${TEST_RUN_PATH}/iter/a1`),
    marker: "nav-iteration-page",
    crumbs: [...TEST_RUN_TRAIL, "Iteration #1"],
    back: "Back to test run",
  },
} satisfies Record<string, PageExpectation>;

type PageName = keyof typeof PAGES;

/** eval_nav_page_viewed `page` for each page in table P. */
const VIEW_NAMES: Record<PageName, string> = {
  suites: "suites",
  runs: "runs",
  suite: "suite",
  settings: "suite_settings",
  cases: "suite_settings",
  evaluators: "suite_settings",
  newCase: "new_test_case",
  testCase: "test_case",
  caseEvaluators: "test_case_evaluators",
  suiteRun: "suite_run",
  testRun: "test_run",
  edit: "test_run_edit",
  iteration: "iteration",
};

function page(
  name: PageName,
  overrides: Partial<PageExpectation> = {},
): PageExpectation {
  return { ...PAGES[name], ...overrides };
}

function eventsNamed(name: string): Record<string, unknown>[] {
  return mocks.track.mock.calls
    .filter(([event]) => event === name)
    .map(([, props]) => props as Record<string, unknown>);
}

/** Asserts exactly one new page view since `seen`, with these props; returns the new total. */
function expectOneView(
  seen: number,
  props: { page: string; arrived_via: string },
): number {
  const views = eventsNamed("eval_nav_page_viewed");
  expect(views.slice(seen)).toEqual([
    expect.objectContaining({
      ...props,
      ui: "nav",
      project_id: PROJECT_ID,
      location: "evaluate_tab",
    }),
  ]);
  return views.length;
}

/** Runs whose decisions were read since the last reset: one reader per launch run. */
function decisionReaders(): string[] {
  return [...new Set(mocks.decisionRunIds)].sort();
}

const apps: FlowApp[] = [];
function open(url: string): FlowApp {
  const app = renderEvaluateApp(url);
  apps.push(app);
  return app;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(HOW_SUITES_WORK_SEEN_KEY, "1");
  mocks.track.mockReset();
  mocks.toast.mockReset();
  mocks.copyMutation.mockReset();
  mocks.decisionReads = 0;
  mocks.decisionRunIds = [];
});

afterEach(() => {
  cleanup();
  for (const app of apps.splice(0)) app.router.dispose();
});

const historyAction = (app: FlowApp) => app.router.state.historyAction;

function landingTab(name: "Suites" | "Runs"): HTMLElement {
  return within(
    screen.getByRole("navigation", { name: "Evaluate view" }),
  ).getByRole("button", { name });
}

describe("Evaluate navigation through the data router (evaluate-nav-enabled on)", () => {
  it("registers every Evaluate path the walk covers", () => {
    expect([...EVALUATE_ROUTE_PATHS].sort()).toEqual(
      [
        "evaluate",
        "evaluate/*",
        "evaluate/create",
        "evaluate/eval-server/:serverId",
        "evaluate/runs",
        "evaluate/suite/:suiteId",
        "evaluate/suite/:suiteId/edit",
        "evaluate/suite/:suiteId/runs/:runId",
        "evaluate/suite/:suiteId/runs/:runId/cases/:testCaseId",
        "evaluate/suite/:suiteId/runs/:runId/cases/:testCaseId/edit",
        "evaluate/suite/:suiteId/runs/:runId/cases/:testCaseId/iter/:iterationId",
        "evaluate/suite/:suiteId/runs/:runId/compare",
        "evaluate/suite/:suiteId/settings",
        "evaluate/suite/:suiteId/settings/cases",
        "evaluate/suite/:suiteId/settings/cases/:testCaseId",
        "evaluate/suite/:suiteId/settings/cases/:testCaseId/evaluators",
        "evaluate/suite/:suiteId/settings/cases/new",
        "evaluate/suite/:suiteId/settings/evaluators",
        "evaluate/suite/:suiteId/test/:testId",
        "evaluate/suite/:suiteId/test/:testId/edit",
      ].sort(),
    );
  });

  it("walks the spec's ten steps by clicking, with the right breadcrumb and Back on each page", async () => {
    // 1. Evaluate, then the Runs tab and back to Suites.
    const app = open(PAGES.suites.url);
    await expectPage(app, page("suites"));
    let views = expectOneView(0, { page: "suites", arrived_via: "direct" });
    await step(
      app,
      () => app.user.click(landingTab("Runs")),
      page("runs", { previousMarker: "nav-suite-overview" }),
    );
    expect(historyAction(app)).toBe("PUSH");
    views = expectOneView(views, { page: "runs", arrived_via: "link" });
    await step(
      app,
      () => app.user.click(landingTab("Suites")),
      page("suites", { previousMarker: "project-runs-table" }),
    );
    expect(historyAction(app)).toBe("PUSH");
    views = expectOneView(views, { page: "suites", arrived_via: "link" });

    // 2. Suite.
    await step(
      app,
      async () => {
        const card = document.querySelector<HTMLElement>(
          `[data-suite-id="${SUITE_ID}"]`,
        );
        const open = card?.querySelector("button");
        if (!open) throw new Error("no suite card button");
        await app.user.click(open);
      },
      page("suite", { previousMarker: "nav-suite-overview" }),
    );
    expect(historyAction(app)).toBe("PUSH");
    views = expectOneView(views, { page: "suite", arrived_via: "link" });

    // 3. Suite settings.
    await step(
      app,
      () =>
        app.user.click(screen.getByRole("button", { name: "Suite settings" })),
      page("settings", { previousMarker: "nav-suite-page" }),
    );
    expect(historyAction(app)).toBe("PUSH");
    views = expectOneView(views, {
      page: "suite_settings",
      arrived_via: "link",
    });

    // 4. Test cases tab, then copy a case to another suite.
    await step(
      app,
      () => app.user.click(screen.getByTestId("suite-settings-tab-cases")),
      page("cases"),
    );
    expect(historyAction(app)).toBe("REPLACE");
    views = eventsNamed("eval_nav_page_viewed").length;
    await copySketchToAsana(app);

    // 5. New case, then its Suite settings crumb.
    await step(
      app,
      async () => {
        await app.user.click(screen.getByTestId("suite-settings-add-case"));
        await app.user.click(
          await screen.findByTestId("suite-settings-add-case-describe"),
        );
      },
      page("newCase", { previousMarker: "suite-settings-test-cases" }),
    );
    expect(historyAction(app)).toBe("PUSH");
    views = expectOneView(views, {
      page: "new_test_case",
      arrived_via: "link",
    });
    await step(
      app,
      () => clickCrumb(app, "Suite settings"),
      page("cases", { previousMarker: "case-steps-editor" }),
    );
    expect(historyAction(app)).toBe("PUSH");
    views = expectOneView(views, {
      page: "suite_settings",
      arrived_via: "crumb",
    });

    // 6. Test case.
    await step(
      app,
      () =>
        app.user.click(
          screen.getByTestId("suite-settings-case-row-case-sketch"),
        ),
      page("testCase", { previousMarker: "suite-settings-test-cases" }),
    );
    expect(historyAction(app)).toBe("PUSH");
    views = expectOneView(views, { page: "test_case", arrived_via: "link" });

    // 7. Its evaluators, then the suite crumb.
    await step(
      app,
      () =>
        app.user.click(
          screen.getByRole("button", { name: "Test Case Evaluators" }),
        ),
      page("caseEvaluators", { previousMarker: "case-steps-editor" }),
    );
    expect(historyAction(app)).toBe("PUSH");
    views = expectOneView(views, {
      page: "test_case_evaluators",
      arrived_via: "link",
    });
    await step(
      app,
      () => clickCrumb(app, SUITE_NAME),
      page("suite", { previousMarker: "case-checks-page" }),
    );
    expect(historyAction(app)).toBe("PUSH");
    views = expectOneView(views, { page: "suite", arrived_via: "crumb" });

    // 8. Suite run.
    await step(
      app,
      () => app.user.click(screen.getByTestId("suite-run-row-run-a")),
      page("suiteRun", { previousMarker: "nav-suite-page" }),
    );
    expect(historyAction(app)).toBe("PUSH");
    views = expectOneView(views, { page: "suite_run", arrived_via: "link" });

    // 9. Test run, with one decision reader per launch run.
    mocks.decisionRunIds = [];
    await step(
      app,
      () =>
        app.user.click(
          screen.getByRole("button", { name: "Open test run case-sketch" }),
        ),
      page("testRun", { previousMarker: "nav-run-page" }),
    );
    expect(historyAction(app)).toBe("PUSH");
    views = expectOneView(views, { page: "test_run", arrived_via: "link" });
    expect(decisionReaders()).toEqual(["run-a", "run-b", "run-c"]);

    // 10. Iteration, then Back to the test run.
    await step(
      app,
      () =>
        app.user.click(
          screen.getByRole("button", { name: "Open iteration 1 details" }),
        ),
      page("iteration", {
        url: suiteUrl(`${TEST_RUN_PATH}/iter/${FIRST_ITERATION_ID}`),
        previousMarker: "nav-test-run",
      }),
    );
    expect(screen.queryByTestId("nav-iteration-loading")).toBeNull();
    expect(historyAction(app)).toBe("PUSH");
    views = expectOneView(views, { page: "iteration", arrived_via: "link" });
    await step(
      app,
      () => clickBack(app),
      page("testRun", { previousMarker: "nav-iteration-page" }),
    );
    expect(historyAction(app)).toBe("PUSH");
    expectOneView(views, { page: "test_run", arrived_via: "back" });
  }, 30_000);

  it("goes test run → Edit Test Case → Back twice, and the page swaps every time", async () => {
    const app = open(suiteUrl(RUN_PATH));
    await expectPage(app, page("suiteRun"));
    mocks.decisionRunIds = [];
    await step(
      app,
      () =>
        app.user.click(
          screen.getByRole("button", { name: "Open test run case-sketch" }),
        ),
      page("testRun", { previousMarker: "nav-run-page" }),
    );
    expect(decisionReaders()).toEqual(["run-a", "run-b", "run-c"]);

    for (let round = 1; round <= 2; round += 1) {
      await step(
        app,
        () =>
          app.user.click(
            screen.getByRole("button", { name: "Edit Test Case" }),
          ),
        page("edit", { previousMarker: "nav-test-run" }),
      );
      expect(historyAction(app)).toBe("PUSH");
      expect(eventsNamed("eval_edit_from_test_run")).toEqual(
        Array.from({ length: round }, () => ({
          surface: "page",
          project_id: PROJECT_ID,
          location: "evaluate_tab",
        })),
      );
      await step(
        app,
        () => clickBack(app),
        page("testRun", { previousMarker: "case-steps-editor" }),
      );
    }
  }, 30_000);

  it("returns from Edit Test Case to its test run through the case crumb", async () => {
    const app = open(PAGES.edit.url);
    await expectPage(app, page("edit"));
    await step(
      app,
      () => clickCrumb(app, CASE_TITLE),
      page("testRun", { previousMarker: "case-steps-editor" }),
    );
    expect(historyAction(app)).toBe("PUSH");
    expect(eventsNamed("eval_nav_page_viewed").at(-1)).toMatchObject({
      page: "test_run",
      arrived_via: "crumb",
    });
  });

  it("copies a case to another suite and Open copy lands on the copy", async () => {
    const app = open(PAGES.cases.url);
    await expectPage(app, page("cases"));
    const openCopy = await copySketchToAsana(app);
    const copyUrl = projectUrl(
      `/evaluate/suite/${COPY_SUITE_ID}/settings/cases/case-sketch-copy`,
    );
    await step(app, openCopy, {
      url: copyUrl,
      marker: "case-steps-editor",
      previousMarker: "suite-settings-test-cases",
      crumbs: ["Evaluate", COPY_SUITE_NAME, "Suite settings", CASE_TITLE],
      back: "Back to suite settings",
    });
    expect(historyAction(app)).toBe("PUSH");
    await step(app, () => clickBack(app), {
      url: projectUrl(`/evaluate/suite/${COPY_SUITE_ID}/settings/cases`),
      marker: "suite-settings-test-cases",
      previousMarker: "case-steps-editor",
      crumbs: ["Evaluate", COPY_SUITE_NAME, "Suite settings"],
      back: "Back to suite",
    });
  });

  const DIRECT_PAGES = (Object.keys(PAGES) as PageName[]).map((name) => ({
    page: name,
  }));

  it.each(DIRECT_PAGES)(
    "loads $page directly and builds its trail from the address alone",
    async ({ page: name }) => {
      const app = open(PAGES[name].url);
      await expectPage(app, page(name));
      expectOneView(0, { page: VIEW_NAMES[name], arrived_via: "direct" });
    },
  );
});

/**
 * Opens the copy menu for `case-sketch`, picks Asana and checks the copy, and
 * returns the toast's Open copy action (the toast itself is mocked).
 */
async function copySketchToAsana(app: FlowApp): Promise<() => Promise<void>> {
  const before = app.location();
  await app.user.click(
    screen.getByTestId("suite-settings-case-copy-case-sketch"),
  );
  const asana = await screen.findByTestId(
    `suite-settings-copy-target-${COPY_SUITE_ID}`,
  );
  const ci = screen.getByTestId(`suite-settings-copy-target-${CI_SUITE_ID}`);
  expect(asana).not.toHaveAttribute("aria-disabled", "true");
  expect(ci).toHaveAttribute("aria-disabled", "true");
  mocks.copyMutation.mockResolvedValue({
    testCaseId: "case-sketch-copy",
    title: CASE_TITLE,
  });
  await app.user.click(asana);
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
  expect(mocks.copyMutation).toHaveBeenCalledTimes(1);
  expect(mocks.copyMutation).toHaveBeenCalledWith({
    testCaseId: "case-sketch",
    targetSuiteId: COPY_SUITE_ID,
  });
  const [title, options] = mocks.toast.mock.calls[0];
  expect(title).toBe(`Copied “${CASE_TITLE}” to ${COPY_SUITE_NAME}`);
  expect(options).toMatchObject({
    description: "Runs were not copied.",
    action: { label: "Open copy" },
  });
  expect(app.location()).toBe(before);
  const action: unknown = Reflect.get(
    Reflect.get(options, "action"),
    "onClick",
  );
  if (typeof action !== "function") throw new Error("toast has no Open copy");
  return async () => {
    action();
  };
}

/** One row of 2F's address table, loaded directly with the flag on. */
interface RedirectRow {
  row: number;
  from: string;
  to: string;
  fromKind: string;
  toKind: string;
  marker: string;
  crumbs: readonly string[];
  back: string | null;
}

const REDIRECT_ROWS: RedirectRow[] = [
  {
    row: 5,
    from: suiteUrl("?view=test-cases"),
    to: PAGES.cases.url,
    fromKind: "suite-overview",
    toKind: "suite-settings",
    marker: PAGES.cases.marker,
    crumbs: SETTINGS_TRAIL,
    back: "Back to suite",
  },
  {
    row: 7,
    from: suiteUrl("/edit"),
    to: PAGES.settings.url,
    fromKind: "suite-edit",
    toKind: "suite-settings",
    marker: PAGES.settings.marker,
    crumbs: SETTINGS_TRAIL,
    back: "Back to suite",
  },
  {
    row: 8,
    from: suiteUrl("/edit?fromCaseChecks=case-sketch"),
    to: PAGES.evaluators.url,
    fromKind: "suite-edit",
    toKind: "suite-settings",
    marker: PAGES.evaluators.marker,
    crumbs: SETTINGS_TRAIL,
    back: "Back to test case evaluators",
  },
  {
    row: 9,
    from: suiteUrl("/test/draft%3Adescribe/edit"),
    to: PAGES.newCase.url,
    fromKind: "test-edit",
    toKind: "case-new",
    marker: PAGES.newCase.marker,
    crumbs: PAGES.newCase.crumbs,
    back: null,
  },
  {
    row: 11,
    from: suiteUrl("/test/case-sketch/edit"),
    to: PAGES.testCase.url,
    fromKind: "test-edit",
    toKind: "case-settings",
    marker: PAGES.testCase.marker,
    crumbs: PAGES.testCase.crumbs,
    back: "Back to suite settings",
  },
  {
    row: 12,
    from: suiteUrl("/test/case-sketch/edit?checks=1"),
    to: PAGES.caseEvaluators.url,
    fromKind: "test-edit",
    toKind: "case-evaluators",
    marker: PAGES.caseEvaluators.marker,
    crumbs: PAGES.caseEvaluators.crumbs,
    back: null,
  },
  {
    row: 14,
    from: suiteUrl("/test/case-sketch/edit?iteration=b1"),
    to: suiteUrl("/runs/run-b/cases/case-sketch/iter/b1"),
    fromKind: "test-edit",
    toKind: "iteration",
    marker: PAGES.iteration.marker,
    crumbs: ["Evaluate", SUITE_NAME, "Run #5", CASE_TITLE, "Iteration #1"],
    back: "Back to test run",
  },
  {
    row: 16,
    from: suiteUrl("/test/case-sketch"),
    to: PAGES.testCase.url,
    fromKind: "test-detail",
    toKind: "case-settings",
    marker: PAGES.testCase.marker,
    crumbs: PAGES.testCase.crumbs,
    back: "Back to suite settings",
  },
  {
    row: 19,
    from: suiteUrl(`${RUN_PATH}?case=case-sketch#trace`),
    to: suiteUrl(`${TEST_RUN_PATH}#trace`),
    fromKind: "run-detail",
    toKind: "test-run",
    marker: PAGES.testRun.marker,
    crumbs: TEST_RUN_TRAIL,
    back: "Back to Run #4",
  },
  {
    row: 20,
    from: suiteUrl(`${RUN_PATH}?case=case-sketch&iteration=a1`),
    to: suiteUrl(`${TEST_RUN_PATH}/iter/a1`),
    fromKind: "run-detail",
    toKind: "iteration",
    marker: PAGES.iteration.marker,
    crumbs: [...TEST_RUN_TRAIL, "Iteration #1"],
    back: "Back to test run",
  },
  {
    row: 21,
    from: suiteUrl(`${RUN_PATH}?iteration=a2`),
    to: suiteUrl(`${TEST_RUN_PATH}/iter/a2`),
    fromKind: "run-detail",
    toKind: "iteration",
    marker: PAGES.iteration.marker,
    crumbs: [...TEST_RUN_TRAIL, "Iteration #2"],
    back: "Back to test run",
  },
];

describe("old Evaluate addresses (evaluate-nav-enabled on)", () => {
  it.each(REDIRECT_ROWS)(
    "row $row: $from opens $to",
    async ({ from, to, fromKind, toKind, marker, crumbs, back }) => {
      const app = open(from);
      await expectPage(app, { url: to, marker, crumbs, back });
      expect(historyAction(app)).toBe("REPLACE");
      expect(eventsNamed("eval_nav_redirected")).toEqual([
        {
          from_kind: fromKind,
          to_kind: toKind,
          matched: true,
          project_id: PROJECT_ID,
          location: "evaluate_tab",
        },
      ]);
      expect(eventsNamed("eval_nav_page_viewed")).toEqual([
        expect.objectContaining({ arrived_via: "redirect", ui: "nav" }),
      ]);
    },
  );

  it("row 8: Back on the redirected Suite settings returns to the case's evaluators", async () => {
    const app = open(suiteUrl("/edit?fromCaseChecks=case-sketch"));
    await expectPage(app, {
      url: PAGES.evaluators.url,
      marker: PAGES.evaluators.marker,
      crumbs: SETTINGS_TRAIL,
      back: "Back to test case evaluators",
    });
    await step(
      app,
      () => clickBack(app),
      page("caseEvaluators", { previousMarker: "suite-default-evaluators" }),
    );
    expect(eventsNamed("eval_nav_page_viewed").at(-1)).toMatchObject({
      page: "test_case_evaluators",
      arrived_via: "back",
    });
  });

  it("row 26: an unknown address opens Suites and reports one unmatched redirect", async () => {
    const unknown = suiteUrl("/foo");
    const app = open(unknown);
    await expectPage(app, { ...PAGES.suites, url: unknown });
    expect(screen.queryByTestId("route-not-found")).toBeNull();
    expect(eventsNamed("eval_nav_redirected")).toEqual([
      {
        from_kind: "unknown",
        to_kind: null,
        matched: false,
        project_id: PROJECT_ID,
        location: "evaluate_tab",
      },
    ]);
  });
});
