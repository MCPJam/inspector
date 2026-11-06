import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { renderWithProviders, screen, userEvent } from "@/test";
import { track } from "@/lib/analytics";
import type { EvalRoute } from "@/lib/eval-route-types";
import type { EvalBack, EvalCrumb } from "../../nav/eval-nav-crumbs";
import type { EvalNavPageServices } from "../../nav/eval-nav-page-services";
import type { NavRunOptions } from "../use-nav-run-links";
import type {
  EvalIteration,
  EvalSuite,
  EvalSuiteRun,
} from "../../../evals/types";
import { SuiteRunNavPage } from "../suite-run-nav-page";
import {
  SuiteRunReviewContent,
  type SuiteRunReviewProps,
} from "../../suite-run-review";

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("../../suite-run-matrix", () => ({
  ConfiguredSuiteRunReview: (props: SuiteRunReviewProps) => (
    <SuiteRunReviewContent {...props} />
  ),
}));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => true,
}));
vi.mock("@/hooks/use-available-models", () => ({
  useAvailableModels: () => ({ availableModels: [] }),
}));
vi.mock("convex/react", async (original) => ({
  ...(await original<object>()),
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [{ hostId: "host-1", name: "MCPJam" }],
    isLoading: false,
  }),
}));
vi.mock("@/components/evals/use-run-group-summaries", () => ({
  useRunGroupSummaries: (_suiteId: string, runs: EvalSuiteRun[]) => ({
    runs,
    loadGroup: vi.fn(async () => runs),
  }),
}));
vi.mock("../../use-eval-run-compare", () => ({
  useEvalRunCompare: () => ({ status: "disabled", dto: null, errorKind: null }),
}));

type CrumbBarProps = { crumbs: readonly EvalCrumb[]; back?: EvalBack | null };
const crumbBar = vi.hoisted(() => {
  const state: { props: CrumbBarProps | null } = { props: null };
  return state;
});
vi.mock("../../evals-header", () => ({
  EvalCrumbBar: (props: CrumbBarProps) => {
    crumbBar.props = props;
    return (
      <div data-testid="crumb-bar">
        {props.crumbs.map((crumb) => crumb.label).join(" / ")}
        {props.back ? ` | ${props.back.label}` : ""}
      </div>
    );
  },
}));

const content = vi.hoisted(() => {
  const state: { nav: NavRunOptions | null } = { nav: null };
  return state;
});
vi.mock("../../evaluate-run-content", () => ({
  EvaluateRunContent: (props: {
    nav?: NavRunOptions;
    iterations: unknown[];
  }) => {
    content.nav = props.nav ?? null;
    return <div data-testid="run-content">{props.iterations.length} rows</div>;
  },
}));

const navigate = vi.hoisted(() => vi.fn());
vi.mock("../../nav/eval-nav-state", async (original) => ({
  ...(await original<object>()),
  useEvalNavigate: () => navigate,
}));

const services = vi.hoisted(() => {
  const state: { current: EvalNavPageServices | null } = { current: null };
  return state;
});
vi.mock("../../nav/eval-nav-page-services", () => ({
  useEvalNavPageServices: () => services.current,
}));

const data = vi.hoisted(() => {
  const state: {
    queries: Record<string, unknown>;
    selected: {
      run: EvalSuiteRun | null;
      isLoading: boolean;
      isUnavailable: boolean;
    };
    rows: {
      byRun: Map<string, EvalIteration[]>;
      failedRunIds: Set<string>;
      iterations: EvalIteration[];
    };
  } = {
    queries: {},
    selected: { run: null, isLoading: false, isUnavailable: false },
    rows: { byRun: new Map(), failedRunIds: new Set(), iterations: [] },
  };
  return state;
});
vi.mock("@/components/evals/use-eval-queries", () => ({
  useEvalQueries: () => data.queries,
}));
vi.mock("@/components/evals/use-selected-run", () => ({
  useSelectedRun: () => data.selected,
}));
vi.mock("@/components/evals/use-runs-iterations", async (original) => ({
  ...(await original<object>()),
  useRunsIterations: () => data.rows,
}));

const suite: EvalSuite = {
  _id: "suite-1",
  createdBy: "u1",
  name: "Excalidraw quickstart",
  description: "",
  configRevision: "1",
  environment: { servers: [] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
  defaultPassCriteria: { minimumPassRate: 70 },
};

function run(
  id: string,
  runNumber: number,
  overrides: Partial<EvalSuiteRun> = {},
): EvalSuiteRun {
  return {
    _id: id,
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "failed",
    createdAt: runNumber * 1000,
    namedHostId: "host-1",
    effectiveModelId: "gpt-5-mini",
    ...overrides,
  };
}

const run4 = run("run-4", 4);
const iteration: EvalIteration = {
  _id: "it-1",
  createdBy: "u1",
  createdAt: 1,
  updatedAt: 2,
  iterationNumber: 1,
  status: "completed",
  result: "failed",
  actualToolCalls: [],
  tokensUsed: 1,
  suiteRunId: "run-4",
  testCaseId: "case-1",
  testCaseSnapshot: {
    title: "Draw",
    query: "Draw",
    provider: "openai",
    model: "gpt-5-mini",
    expectedToolCalls: [],
  },
};

function makeServices(): EvalNavPageServices {
  return {
    runCase: vi.fn(),
    deleteTestCase: vi.fn(),
    launchReview: () => ({ suite, projectId: "p1", hostNamesById: new Map() }),
    evalRunsDisabledReason: null,
    isDirectGuest: false,
    projectServers: [],
    connectedServerNames: new Set(),
    ensureServersReady: vi.fn(),
    runSuite: vi.fn(async () => ({ runIds: ["new"] })),
    rerunningSuiteId: null,
    cancelRun: vi.fn(async () => undefined),
    cancellingRunId: null,
    canDeleteRun: () => true,
    replayingRunId: null,
    runningTestCaseId: null,
    duplicateSuite: vi.fn(),
    openCreateSuite: vi.fn(),
    quickstart: null,
  };
}

const route: Extract<EvalRoute, { type: "run-detail" }> = {
  type: "run-detail",
  suiteId: "suite-1",
  runId: "run-4",
};

function renderPage(state?: unknown) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter
      initialEntries={[
        { pathname: "/p/p1/evaluate/suite/suite-1/runs/run-4", state },
      ]}
    >
      {children}
    </MemoryRouter>
  );
  return renderWithProviders(<SuiteRunNavPage route={route} projectId="p1" />, {
    wrapper,
  });
}

beforeEach(() => {
  navigate.mockClear();
  vi.mocked(track).mockClear();
  services.current = makeServices();
  content.nav = null;
  data.queries = {
    selectedSuite: suite,
    selectedSuiteEntry: { suite },
    suiteDetails: {
      testCases: [
        {
          _id: "case-1",
          testSuiteId: "suite-1",
          createdBy: "u1",
          title: "Draw",
          query: "Draw",
          models: [{ model: "gpt-5-mini", provider: "openai" }],
          runs: 1,
          expectedToolCalls: [],
        },
      ],
    },
    runsForSelectedSuite: [run4, run("run-3", 3)],
    isOverviewLoading: false,
    isSuiteDetailsLoading: false,
  };
  data.selected = { run: run4, isLoading: false, isUnavailable: false };
  data.rows = {
    byRun: new Map([["run-4", [iteration]]]),
    failedRunIds: new Set(),
    iterations: [iteration],
  };
});

describe("SuiteRunNavPage", () => {
  it("renders Evaluate / <suite> / Run #N with Back to suite, and its page view", () => {
    renderPage();
    expect(screen.getByTestId("crumb-bar")).toHaveTextContent(
      "Evaluate / Excalidraw quickstart / Run #4 | Back to suite",
    );
    expect(screen.getByRole("heading", { name: "Suite Run #4" })).toBeTruthy();
    expect(track).toHaveBeenCalledWith(
      "eval_nav_page_viewed",
      expect.objectContaining({
        page: "suite_run",
        ui: "nav",
        project_id: "p1",
      }),
    );
  });

  it("names the page you came from in Back", () => {
    renderPage({
      evalNav: { via: "link", from: { path: "/evaluate/runs", place: "Runs" } },
    });
    expect(crumbBar.props?.back).toEqual({
      label: "Back to Runs",
      path: "/evaluate/runs",
    });
  });

  it("says Loading run... while the rows are on their way", () => {
    data.rows = { byRun: new Map(), failedRunIds: new Set(), iterations: [] };
    renderPage();
    expect(screen.getByText("Loading run...")).toBeVisible();
    expect(screen.queryByTestId("run-content")).toBeNull();
  });

  it("says Run unavailable. for a run this suite does not have", () => {
    data.selected = { run: null, isLoading: false, isUnavailable: true };
    renderPage();
    expect(screen.getByText("Run unavailable.")).toBeVisible();
  });

  it("opens the comparison page from Compare runs, with this run as Back", async () => {
    renderPage();
    await userEvent
      .setup()
      .click(screen.getByTestId("evaluate-run-compare-open"));
    expect(navigate).toHaveBeenCalledWith(
      {
        type: "run-detail",
        suiteId: "suite-1",
        runId: "run-4",
        comparison: true,
      },
      {
        via: "link",
        from: {
          route,
          names: { suiteName: "Excalidraw quickstart", runNumber: 4 },
        },
      },
    );
  });

  it("opens Suite settings with this run as Back", async () => {
    renderPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Suite settings" }));
    expect(navigate).toHaveBeenCalledWith(
      { type: "suite-settings", suiteId: "suite-1", tab: "settings" },
      expect.objectContaining({ via: "link" }),
    );
  });

  it("runs again through runSuite", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Run again" }));
    await user.click(screen.getByRole("button", { name: "Start run" }));
    expect(services.current?.runSuite).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "suite-1" }),
      expect.objectContaining({ iterationOverride: expect.any(Number) }),
    );
  });

  it("links test runs, edits and iterations to the new pages", () => {
    renderPage();
    const nav = content.nav;
    expect(nav?.passThreshold).toBe(0.7);
    nav?.openTestRun("case-1", null);
    nav?.openTestRun("case-1", "gpt-5-mini");
    nav?.editTestCase("case-1");
    nav?.openIteration(iteration);
    const from = {
      route,
      names: { suiteName: "Excalidraw quickstart", runNumber: 4 },
    };
    expect(navigate.mock.calls).toEqual([
      [
        {
          type: "test-run",
          suiteId: "suite-1",
          runId: "run-4",
          testCaseId: "case-1",
        },
        { via: "link", from },
      ],
      [
        {
          type: "test-run",
          suiteId: "suite-1",
          runId: "run-4",
          testCaseId: "case-1",
          target: "gpt-5-mini",
        },
        { via: "link", from },
      ],
      [
        {
          type: "test-run-edit",
          suiteId: "suite-1",
          runId: "run-4",
          testCaseId: "case-1",
        },
        { via: "link", from },
      ],
      [
        {
          type: "iteration",
          suiteId: "suite-1",
          runId: "run-4",
          testCaseId: "case-1",
          iterationId: "it-1",
        },
        { via: "link", from },
      ],
    ]);
    expect(track).toHaveBeenCalledWith("eval_edit_from_test_run", {
      surface: "list",
      project_id: "p1",
      location: "evaluate_tab",
    });
  });
});
