import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalSuiteOverviewEntry } from "../../../evals/types";
import { makeEntry, makeRun, makeSuite } from "./suite-card-fixtures";

const state = vi.hoisted(() => ({
  suites: [] as EvalSuiteOverviewEntry[],
  loading: false,
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
}));
vi.mock("../../../evals/use-eval-queries", () => ({
  useEvalQueries: () => ({
    sortedSuites: state.suites,
    isOverviewLoading: state.loading,
  }),
}));
vi.mock("@/hooks/use-eval-tab-context", () => ({
  useEvalTabContext: () => ({ canDeleteArtifact: () => true }),
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({ hosts: [] }),
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: () => [],
}));
vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: () => "light",
}));
vi.mock("../../../evals/project-runs-table", () => ({
  ProjectRunsTable: (props: {
    navLanding?: boolean;
    onSelectRun: (target: { suiteId: string; runId: string }) => void;
  }) => (
    <button
      type="button"
      data-testid="runs-table"
      data-nav-landing={String(props.navLanding)}
      onClick={() => props.onSelectRun({ suiteId: "s", runId: "r" })}
    >
      runs table
    </button>
  ),
}));
vi.mock("../../suite-list-run-review", () => ({
  SuiteListRunReview: (props: {
    suite: { _id: string };
    onStart: (suite: unknown, options: { iterationOverride: number }) => void;
    onEditSettings: () => void;
  }) => (
    <div role="dialog" aria-label="Run review">
      <button
        type="button"
        onClick={() => props.onStart(props.suite, { iterationOverride: 1 })}
      >
        Start
      </button>
      <button type="button" onClick={props.onEditSettings}>
        Edit settings
      </button>
    </div>
  ),
}));

import { track } from "@/lib/analytics";
import {
  EvalNavPageServicesProvider,
  type EvalNavPageServices,
} from "../../nav/eval-nav-page-services";
import { EvaluateLandingPage } from "../evaluate-landing-page";

const PROJECT = "proj000000000001";
let location: ReturnType<typeof useLocation> | null = null;
function LocationProbe() {
  location = useLocation();
  return null;
}

function makeServices(
  overrides: Partial<EvalNavPageServices> = {},
): EvalNavPageServices {
  return {
    runCase: vi.fn(),
    deleteTestCase: vi.fn(),
    launchReview: vi.fn(),
    evalRunsDisabledReason: null,
    isDirectGuest: false,
    projectServers: [],
    connectedServerNames: new Set(),
    ensureServersReady: vi.fn(),
    runSuite: vi.fn(async () => undefined),
    rerunningSuiteId: null,
    cancelRun: vi.fn(async () => undefined),
    cancellingRunId: null,
    deleteRun: vi.fn(),
    canDeleteRun: () => true,
    replayingRunId: null,
    runningTestCaseId: null,
    duplicateSuite: vi.fn(),
    openCreateSuite: vi.fn(),
    quickstart: { running: false, run: vi.fn() },
    ...overrides,
  };
}

function LandingAt({ type }: { type: "list" | "evaluate-runs" }) {
  return <EvaluateLandingPage route={{ type }} projectId={PROJECT} />;
}

function renderLanding(
  path: "/evaluate" | "/evaluate/runs" = "/evaluate",
  services = makeServices(),
) {
  const utils = render(
    <MemoryRouter initialEntries={[`/p/${PROJECT}${path}`]}>
      <EvalNavPageServicesProvider value={services}>
        <Routes>
          <Route
            path="/p/:project/evaluate/runs"
            element={<LandingAt type="evaluate-runs" />}
          />
          <Route
            path="/p/:project/evaluate"
            element={<LandingAt type="list" />}
          />
          <Route path="*" element={<p>elsewhere</p>} />
        </Routes>
      </EvalNavPageServicesProvider>
      <LocationProbe />
    </MemoryRouter>,
  );
  return { ...utils, services };
}

const tab = (name: string) => screen.getByRole("button", { name });
const pageViews = () =>
  vi
    .mocked(track)
    .mock.calls.filter(([name]) => name === "eval_nav_page_viewed");

describe("EvaluateLandingPage", () => {
  beforeEach(() => {
    vi.mocked(track).mockClear();
    state.loading = false;
    state.suites = [
      makeEntry(makeSuite("s", { name: "Checkout" }), [makeRun("s", 1)]),
    ];
  });

  it("opens on Suites at /evaluate and Runs at /evaluate/runs", () => {
    renderLanding();
    expect(tab("Suites")).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Checkout")).toBeInTheDocument();
  });

  it("shows the Runs table with navLanding at /evaluate/runs", () => {
    renderLanding("/evaluate/runs");
    expect(tab("Runs")).toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("runs-table")).toHaveAttribute(
      "data-nav-landing",
      "true",
    );
    fireEvent.click(screen.getByTestId("runs-table"));
    expect(location?.pathname).toBe(`/p/${PROJECT}/evaluate/suite/s/runs/r`);
    expect(location?.state).toEqual({
      evalNav: { via: "link", from: { path: "/evaluate/runs", place: "Runs" } },
    });
  });

  it("pushes the Runs address with via link", async () => {
    const user = userEvent.setup();
    renderLanding();
    await user.click(tab("Runs"));
    expect(location?.pathname).toBe(`/p/${PROJECT}/evaluate/runs`);
    expect(location?.state).toEqual({ evalNav: { via: "link" } });
    expect(screen.getByTestId("runs-table")).toBeInTheDocument();
  });

  it("fires one page view per address with ui nav", async () => {
    const user = userEvent.setup();
    renderLanding();
    await user.click(tab("Runs"));
    await user.click(tab("Runs"));
    expect(pageViews().map(([, props]) => props)).toEqual([
      expect.objectContaining({ page: "suites", ui: "nav", tab: null }),
      expect.objectContaining({ page: "runs", ui: "nav", arrived_via: "link" }),
    ]);
  });

  it("creates a suite through the services", async () => {
    const user = userEvent.setup();
    const { services } = renderLanding();
    await user.click(screen.getByRole("button", { name: "Create suite" }));
    expect(services.openCreateSuite).toHaveBeenCalledWith();
  });

  it("opens the run review and starts through runSuite", async () => {
    const user = userEvent.setup();
    const { services } = renderLanding();
    await user.click(screen.getByRole("button", { name: "Run Checkout" }));
    await user.click(screen.getByRole("button", { name: "Start" }));
    expect(services.runSuite).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "s" }),
      { iterationOverride: 1 },
    );
    await user.click(screen.getByRole("button", { name: "Edit settings" }));
    expect(screen.queryByRole("dialog", { name: "Run review" })).toBeNull();
    expect(location?.pathname).toBe(`/p/${PROJECT}/evaluate/suite/s/settings`);
  });

  it("unmounts the run review with the page", async () => {
    const user = userEvent.setup();
    renderLanding();
    await user.click(screen.getByRole("button", { name: "Run Checkout" }));
    expect(screen.getByRole("dialog", { name: "Run review" })).toBeVisible();
    await user.click(screen.getByText("Checkout"));
    expect(screen.getByText("elsewhere")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Run review" })).toBeNull();
  });

  it("cancels a single run and a whole launch", async () => {
    const user = userEvent.setup();
    const single = makeRun("a", 1, { status: "running" });
    const g1 = makeRun("b", 1, { status: "running", runGroupId: "g" });
    const g2 = makeRun("b", 2, { status: "pending", runGroupId: "g" });
    state.suites = [
      makeEntry(makeSuite("a"), [single]),
      makeEntry(makeSuite("b"), [g1, g2]),
    ];
    const { services } = renderLanding();
    await user.click(screen.getByRole("button", { name: "Cancel run for a" }));
    expect(services.cancelRun).toHaveBeenCalledWith([single._id]);
    await user.click(screen.getByRole("button", { name: "Cancel run for b" }));
    expect(vi.mocked(services.cancelRun).mock.calls[1][0]).toEqual(
      expect.arrayContaining([g1._id, g2._id]),
    );
  });

  it("shows the empty hero, wired to the services", async () => {
    const user = userEvent.setup();
    state.suites = [];
    const server = {
      _id: "srv",
      projectId: PROJECT,
      name: "Excalidraw (App)",
      enabled: true,
      transportType: "http" as const,
    };
    const { services } = renderLanding(
      "/evaluate/runs",
      makeServices({ projectServers: [server] }),
    );
    expect(screen.getByTestId("evals-empty-hero")).toBeInTheDocument();
    await user.click(screen.getByText("Excalidraw (App)"));
    expect(services.openCreateSuite).toHaveBeenCalledWith(server);
    await user.click(screen.getByRole("button", { name: "Try sample suite" }));
    expect(services.quickstart?.run).toHaveBeenCalledOnce();
  });

  it("hides the sample suite when quickstart is null", () => {
    state.suites = [];
    renderLanding("/evaluate", makeServices({ quickstart: null }));
    expect(
      screen.queryByRole("button", { name: "Try sample suite" }),
    ).toBeNull();
  });

  it("shows the loading spinner while the overview loads", () => {
    state.loading = true;
    renderLanding();
    expect(screen.getByText("Loading suites...")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Evaluate" })).toBeVisible();
  });
});
