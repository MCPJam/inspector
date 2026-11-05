import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import type { EvalSuiteOverviewEntry } from "../../../evals/types";
import { EvaluateLandingPage } from "../evaluate-landing-page";
import { EvaluateTutorialProvider } from "../evaluate-tutorial";

const navigate = vi.hoisted(() => vi.fn());
const overview = vi.hoisted(() => ({
  suites: [] as EvalSuiteOverviewEntry[],
  isLoading: false,
}));
const request = vi.hoisted(() => vi.fn(() => true));
const openCreate = vi.hoisted(() => vi.fn());
const actions = vi.hoisted(() => ({
  run: {
    rerun: vi.fn(),
    disabledReason: null as string | null,
    judgeRunIds: [] as string[],
  },
  rerunningSuiteId: null as string | null,
  deleteRun: vi.fn() as ((runId: string) => Promise<void>) | undefined,
  canDeleteArtifact: () => true,
  quickstart: { run: vi.fn(), isRunning: false, available: true },
  heroServers: [{ id: "srv_1", name: "Asana" }],
  serversLoading: false,
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => ({ user: {} }) }));
vi.mock("@/hooks/use-is-direct-guest", () => ({
  useIsDirectGuest: () => false,
}));
vi.mock("@/lib/app-route-context", () => ({
  useAppRouteContext: () => ({ convexProjectId: "p_1" }),
}));
vi.mock("../../nav/use-evaluate-nav-navigate", () => ({
  useEvaluateNavNavigate: () => navigate,
}));
vi.mock("../../create-suite-prefill-store", () => ({
  openCreateSuite: openCreate,
}));
vi.mock("../use-evaluate-landing-actions", () => ({
  useEvaluateLandingActions: () => actions,
}));
vi.mock("../../suite-list-run-review", () => ({
  SuiteListRunReview: ({
    suite,
    onStart,
  }: {
    suite: { name: string };
    onStart: (suite: unknown, options: object) => void;
  }) => (
    <button type="button" onClick={() => onStart(suite, {})}>
      Start {suite.name}
    </button>
  ),
}));
vi.mock("../use-evaluate-suite-overview", () => ({
  useEvaluateSuiteOverview: () => overview,
}));
vi.mock("../../../evals/EvalTabGate", () => ({
  EvalTabGate: ({
    header,
    children,
  }: {
    header: ReactNode;
    children: ReactNode;
  }) => (
    <>
      {header}
      {children}
    </>
  ),
}));
vi.mock("../../../evals/project-runs-table", () => ({
  ProjectRunsTable: ({
    projectId,
    onDeleteRun,
  }: {
    projectId: string;
    onDeleteRun?: (runId: string) => void;
  }) => (
    <button type="button" onClick={() => onDeleteRun?.("run_9")}>
      runs of {projectId}
    </button>
  ),
}));
vi.mock("../../how-suites-work/use-how-suites-work", () => ({
  useHowSuitesWork: () => ({ trigger: null, request, close: vi.fn() }),
}));

function entry(
  id: string,
  name: string,
  passRate: number,
): EvalSuiteOverviewEntry {
  const run = {
    _id: `run_${id}`,
    suiteId: id,
    runNumber: 3,
    status: "completed",
    result: passRate >= 0.8 ? "passed" : "failed",
    summary: {
      total: 4,
      passed: passRate * 4,
      failed: 4 - passRate * 4,
      passRate,
    },
    createdAt: Date.now() - 60_000,
  } satisfies Partial<EvalSuiteOverviewEntry["recentRuns"][number]>;
  return {
    suite: { _id: id, name, environment: { servers: ["excalidraw"] } },
    latestRun: null,
    recentRuns: [run],
    passRateTrend: [passRate],
    totals: { passed: 0, failed: 0, runs: 1 },
  } as unknown as EvalSuiteOverviewEntry;
}

function cardNames(): string[] {
  return screen
    .getAllByTestId("evaluate-suite-card")
    .map((card) => card.querySelector(".truncate")?.textContent ?? "");
}

function renderLanding(
  type: "list" | "evaluate-runs" = "list",
  enabled = true,
) {
  return render(
    <EvaluateTutorialProvider enabled={enabled}>
      <EvaluateLandingPage route={{ type }} />
    </EvaluateTutorialProvider>,
  );
}

describe("EvaluateLandingPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    overview.suites = [entry("s_1", "Excalidraw basics", 1)];
    overview.isLoading = false;
  });

  it("opens on Suites with a card per suite and asks for the first-visit tutorial", () => {
    renderLanding();
    expect(screen.getAllByTestId("evaluate-suite-card")).toHaveLength(1);
    expect(screen.getByText("Excalidraw basics")).toBeTruthy();
    expect(screen.getByText("Passed 100%")).toBeTruthy();
    expect(request).toHaveBeenCalledWith("first_visit");
  });

  it("switches tabs by address", async () => {
    renderLanding();
    await userEvent.click(screen.getByRole("button", { name: "Runs" }));
    expect(navigate).toHaveBeenCalledWith({ type: "evaluate-runs" }, "link");
  });

  it("shows the project's runs on the Runs tab", () => {
    renderLanding("evaluate-runs");
    expect(screen.getByText("runs of p_1")).toBeTruthy();
  });

  it("opens Create suite and the tutorial from the ⋮ menu", async () => {
    renderLanding();
    await userEvent.click(screen.getByRole("button", { name: /Create suite/ }));
    expect(openCreate).toHaveBeenCalledWith();
    await userEvent.click(screen.getByRole("button", { name: "More options" }));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Tutorial/ }),
    );
    expect(request).toHaveBeenCalledWith("menu");
  });

  it("opens a suite's run and its settings from the card", async () => {
    renderLanding();
    await userEvent.click(screen.getByRole("button", { name: "Run #3" }));
    // The suite run's Back then returns to the Suites tab.
    expect(navigate).toHaveBeenCalledWith(
      { type: "run-detail", suiteId: "s_1", runId: "run_s_1" },
      "link",
      { backPlace: "suites" },
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Suite settings/ }),
    );
    expect(navigate).toHaveBeenCalledWith(
      { type: "suite-settings", suiteId: "s_1", tab: "settings" },
      "link",
    );
  });

  it("offers the sample suite and the project's servers when there are no suites", async () => {
    overview.suites = [];
    renderLanding();
    expect(screen.getByTestId("evals-empty-hero")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Asana/ }));
    expect(openCreate).toHaveBeenCalledWith({
      name: "Asana",
      serverId: "srv_1",
    });
    await userEvent.click(
      screen.getByRole("button", { name: /sample suite/i }),
    );
    expect(actions.quickstart.run).toHaveBeenCalled();
  });

  it("starts a suite run from the card's review", async () => {
    renderLanding();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Start Excalidraw basics" }),
    );
    expect(actions.run.rerun).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "s_1" }),
      {},
    );
  });

  it("searches and sorts the suites", async () => {
    overview.suites = [
      entry("s_1", "Zeta", 1),
      entry("s_2", "Alpha", 0.5),
      entry("s_3", "Mid", 0.9),
    ];
    renderLanding();
    await userEvent.type(screen.getByLabelText("Search suites"), "a");
    expect(cardNames()).toEqual(["Zeta", "Alpha"]);
    await userEvent.clear(screen.getByLabelText("Search suites"));
    await userEvent.click(screen.getByRole("button", { name: /Sort suites/ }));
    await userEvent.click(
      await screen.findByRole("menuitemradio", { name: "Name" }),
    );
    expect(cardNames()).toEqual(["Alpha", "Mid", "Zeta"]);
    await userEvent.type(screen.getByLabelText("Search suites"), "nothing");
    expect(screen.getByText("No suites match “nothing”.")).toBeTruthy();
  });

  it("deletes runs from the Runs tab", async () => {
    renderLanding("evaluate-runs");
    await userEvent.click(screen.getByRole("button", { name: "runs of p_1" }));
    expect(actions.deleteRun).toHaveBeenCalledWith("run_9");
  });

  it("does not ask for the tutorial with the nav rework off", () => {
    renderLanding("list", false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("EvaluateTutorialProvider", () => {
  beforeEach(() => request.mockClear());

  it("asks for the first-suite tutorial when an empty project gets a suite", () => {
    overview.suites = [];
    const { rerender } = render(
      <EvaluateTutorialProvider enabled projectId="p_1">
        <p>page</p>
      </EvaluateTutorialProvider>,
    );
    expect(request).not.toHaveBeenCalled();
    overview.suites = [entry("s_1", "First", 1)];
    rerender(
      <EvaluateTutorialProvider enabled projectId="p_1">
        <p>page</p>
      </EvaluateTutorialProvider>,
    );
    expect(request).toHaveBeenCalledWith("first_suite");
  });

  it("does not treat a project that already had suites as a first suite", () => {
    overview.suites = [entry("s_1", "Old", 1)];
    render(
      <EvaluateTutorialProvider enabled projectId="p_1">
        <p>page</p>
      </EvaluateTutorialProvider>,
    );
    expect(request).not.toHaveBeenCalled();
  });
});
