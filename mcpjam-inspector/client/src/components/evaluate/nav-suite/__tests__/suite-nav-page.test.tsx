import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent, within } from "@/test";
import { track } from "@/lib/analytics";
import type { EvalBack, EvalCrumb } from "../../nav/eval-nav-crumbs";
import type { EvalNavPageServices } from "../../nav/eval-nav-page-services";
import type { EvalRoute } from "@/lib/eval-route-types";
import {
  SuiteRunReviewContent,
  type SuiteRunReviewProps,
} from "../../suite-run-review";
import { metricsByRunFromIterations } from "../../../evals/run-metrics";
import type {
  EvalCase,
  EvalSuite,
  EvalSuiteRun,
  EvalSuiteRunListItem,
} from "../../../evals/types";
import { SuiteNavPage } from "../suite-nav-page";

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
  useConvex: () => ({ query: vi.fn(async () => null) }),
}));
vi.mock("@/state/app-state-context", () => ({
  useSharedAppState: () => ({ servers: {} }),
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [{ hostId: "host-1", name: "MCPJam" }],
    isLoading: false,
  }),
}));
vi.mock("@/components/evals/eval-export-modal", () => ({
  EvalExportModal: (props: { open: boolean; scope: string }) =>
    props.open ? <div data-testid="export-modal">{props.scope}</div> : null,
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
      </div>
    );
  },
}));
vi.mock("../../landing/suite-pills", () => ({
  SuitePills: (props: { models: (string | null)[]; clients: string[] }) => (
    <span data-testid="suite-pills">
      {[...props.models, ...props.clients].join(" · ")}
    </span>
  ),
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

const queries = vi.hoisted(() => {
  const state: { current: Record<string, unknown> } = { current: {} };
  return state;
});
vi.mock("@/components/evals/use-eval-queries", () => ({
  useEvalQueries: () => queries.current,
}));

const suite: EvalSuite = {
  _id: "suite-1",
  createdBy: "u1",
  name: "Excalidraw quickstart",
  description: "",
  configRevision: "1",
  environment: { servers: ["excalidraw"] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
  defaultPassCriteria: { minimumPassRate: 70 },
};

const testCase: EvalCase = {
  _id: "case-1",
  testSuiteId: "suite-1",
  createdBy: "u1",
  title: "Draw a rectangle",
  query: "Draw a rectangle",
  models: [{ model: "claude-haiku-4-5", provider: "anthropic" }],
  runs: 1,
  expectedToolCalls: [],
};

function run(overrides: Partial<EvalSuiteRun> & { _id: string }): EvalSuiteRun {
  return {
    suiteId: "suite-1",
    createdBy: "u1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "passed",
    createdAt: 1_700_000_000_000,
    completedAt: 1_700_000_010_000,
    source: "ui",
    namedHostId: "host-1",
    effectiveModelId: "claude-haiku-4-5",
    ...overrides,
  };
}

function makeServices(
  overrides: Partial<EvalNavPageServices> = {},
): EvalNavPageServices {
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
    deleteRun: vi.fn(async () => undefined),
    canDeleteRun: () => true,
    replayingRunId: null,
    runningTestCaseId: null,
    duplicateSuite: vi.fn(),
    openCreateSuite: vi.fn(),
    quickstart: null,
    ...overrides,
  };
}

function setQueries(
  overrides: Partial<{
    suite: EvalSuite | null;
    runs: EvalSuiteRunListItem[];
    loading: boolean;
  }> = {},
) {
  const shown = overrides.suite === undefined ? suite : overrides.suite;
  queries.current = {
    selectedSuite: shown,
    selectedSuiteEntry: shown ? { suite: shown } : null,
    suiteDetails: shown ? { testCases: [testCase] } : undefined,
    runsForSelectedSuite: overrides.runs ?? [run({ _id: "run-1" })],
    metricsByRun: metricsByRunFromIterations([]),
    runHistoryStatus: "Exhausted",
    loadMoreRuns: vi.fn(),
    isOverviewLoading: overrides.loading ?? false,
    isSuiteDetailsLoading: overrides.loading ?? false,
    isSuiteRunsLoading: false,
    isRunMetricsLoading: false,
  };
}

const route: EvalRoute = { type: "suite-overview", suiteId: "suite-1" };

function renderPage(pageRoute: EvalRoute = route) {
  return renderWithProviders(
    <SuiteNavPage
      route={pageRoute.type === "suite-overview" ? pageRoute : route}
      projectId="p1"
    />,
  );
}

beforeEach(() => {
  navigate.mockClear();
  vi.mocked(track).mockClear();
  services.current = makeServices();
  setQueries();
});

describe("SuiteNavPage", () => {
  it("renders Evaluate / <suite> with no Back and fires its page view", () => {
    renderPage();
    expect(screen.getByTestId("crumb-bar")).toHaveTextContent(
      "Evaluate / Excalidraw quickstart",
    );
    expect(crumbBar.props?.back).toBeNull();
    expect(track).toHaveBeenCalledWith(
      "eval_nav_page_viewed",
      expect.objectContaining({ page: "suite", ui: "nav", project_id: "p1" }),
    );
    expect(screen.getByTestId("suite-pills")).toHaveTextContent(
      "claude-haiku-4-5 · MCPJam",
    );
  });

  it("shows the loading line while the suite loads", () => {
    setQueries({ suite: null, loading: true });
    renderPage();
    expect(screen.getByText("Loading suite…")).toBeVisible();
    expect(screen.getByTestId("crumb-bar")).toHaveTextContent(
      "Evaluate / Suite",
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("returns to Evaluate when the suite is gone", () => {
    setQueries({ suite: null });
    renderPage();
    expect(navigate).toHaveBeenCalledWith(
      { type: "list" },
      { via: "redirect", replace: true },
    );
  });

  it("forwards ?importJob= to Suite settings › Test cases and shows nothing", () => {
    renderPage({ ...route, importJob: "job-7" });
    expect(navigate).toHaveBeenCalledWith(
      {
        type: "suite-settings",
        suiteId: "suite-1",
        tab: "cases",
        importJob: "job-7",
      },
      { via: "redirect", replace: true },
    );
    expect(screen.queryByTestId("crumb-bar")).toBeNull();
  });

  it("starts a run through runSuite from today's Setup Run sheet", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Run" }));
    await user.click(screen.getByRole("button", { name: "Start run" }));
    expect(services.current?.runSuite).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "suite-1" }),
      expect.objectContaining({ iterationOverride: expect.any(Number) }),
    );
  });

  it("cancels every in-flight run at once", async () => {
    setQueries({
      runs: [
        run({ _id: "a", runNumber: 1, status: "running", result: "pending" }),
        run({ _id: "b", runNumber: 2, status: "running", result: "pending" }),
      ],
    });
    renderPage();
    await userEvent.setup().click(
      within(screen.getByTestId("suite-page-header")).getByRole("button", {
        name: "Cancel run",
      }),
    );
    expect(services.current?.cancelRun).toHaveBeenCalledWith(
      expect.arrayContaining(["a", "b"]),
    );
  });

  it("offers run delete only when the services allow it", () => {
    const { unmount } = renderPage();
    expect(screen.getByRole("button", { name: "Delete run #1" })).toBeTruthy();
    unmount();
    services.current = makeServices({ deleteRun: undefined });
    renderPage();
    expect(screen.queryByRole("button", { name: /Delete run/ })).toBeNull();
  });

  it("opens the suite export from Export as SDK", async () => {
    renderPage();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Export as SDK" }));
    expect(await screen.findByTestId("export-modal")).toHaveTextContent(
      "suite",
    );
  });

  it("links runs and Suite settings with the suite page as Back", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      screen.getByRole("button", { name: "Open run #1", exact: true }),
    );
    await user.click(screen.getByRole("button", { name: "Suite settings" }));
    const from = { route, names: { suiteName: "Excalidraw quickstart" } };
    expect(navigate.mock.calls).toEqual([
      [
        { type: "run-detail", suiteId: "suite-1", runId: "run-1" },
        { via: "link", from },
      ],
      [
        { type: "suite-settings", suiteId: "suite-1", tab: "settings" },
        { via: "link", from },
      ],
    ]);
  });

  it("hides Suite settings from a direct guest", () => {
    services.current = makeServices({ isDirectGuest: true });
    renderPage();
    expect(screen.queryByRole("button", { name: "Suite settings" })).toBeNull();
  });
});
