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
vi.mock("../../create-suite-navigation", () => ({
  navigatePlaygroundEvalsRoute: navigate,
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
  ProjectRunsTable: ({ projectId }: { projectId: string }) => (
    <p>runs of {projectId}</p>
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
    suite: { _id: id, name },
    latestRun: null,
    recentRuns: [run],
    passRateTrend: [passRate],
    totals: { passed: 0, failed: 0, runs: 1 },
  } as unknown as EvalSuiteOverviewEntry;
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
    navigate.mockClear();
    request.mockClear();
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
    expect(navigate).toHaveBeenCalledWith({ type: "evaluate-runs" });
  });

  it("shows the project's runs on the Runs tab", () => {
    renderLanding("evaluate-runs");
    expect(screen.getByText("runs of p_1")).toBeTruthy();
  });

  it("opens Create suite and the tutorial from the ⋮ menu", async () => {
    renderLanding();
    await userEvent.click(screen.getByRole("button", { name: /Create suite/ }));
    expect(navigate).toHaveBeenCalledWith({ type: "create" });
    await userEvent.click(screen.getByRole("button", { name: "More options" }));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: /Tutorial/ }),
    );
    expect(request).toHaveBeenCalledWith("menu");
  });

  it("opens a suite's run and its settings from the card", async () => {
    renderLanding();
    await userEvent.click(screen.getByRole("button", { name: "Run #3" }));
    expect(navigate).toHaveBeenCalledWith({
      type: "run-detail",
      suiteId: "s_1",
      runId: "run_s_1",
    });
    await userEvent.click(
      screen.getByRole("button", { name: /Suite settings/ }),
    );
    expect(navigate).toHaveBeenCalledWith({
      type: "suite-settings",
      suiteId: "s_1",
      tab: "settings",
    });
  });

  it("offers Create suite when the project has no suites", () => {
    overview.suites = [];
    renderLanding();
    expect(screen.getByTestId("evals-empty-hero")).toBeTruthy();
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
