import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { SuiteDetailOverview } from "../../suite-detail-overview";
import { metricsByRunFromIterations } from "../../../evals/run-metrics";
import type { EvalCase, EvalSuite, EvalSuiteRun } from "../../../evals/types";

const mocks = vi.hoisted(() => ({ open: vi.fn(), track: vi.fn() }));
vi.mock("../../nav/use-evaluate-nav-enabled", () => ({
  useEvaluateNavEnabled: () => true,
}));
vi.mock("../eval-nav-link", async (original) => ({
  ...(await original<object>()),
  openEvalNavPage: mocks.open,
}));
vi.mock("@/lib/analytics", () => ({ track: mocks.track }));
vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => false,
}));

const suite = {
  _id: "suite-1",
  createdBy: "u1",
  name: "Excalidraw quickstart",
  description: "",
  configRevision: "1",
  environment: { servers: ["excalidraw"] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
} as EvalSuite;

const testCase = {
  _id: "case-1",
  testSuiteId: "suite-1",
  createdBy: "u1",
  title: "Draw a rectangle",
  query: "Draw",
  models: [{ model: "claude-haiku-4.5", provider: "anthropic" }],
  runs: 1,
  expectedToolCalls: [],
} as EvalCase;

const run = {
  _id: "run-6",
  suiteId: "suite-1",
  createdBy: "u1",
  runNumber: 6,
  configRevision: "1",
  configSnapshot: { tests: [], environment: { servers: [] } },
  status: "completed",
  result: "failed",
  createdAt: 1_700_000_000_000,
  completedAt: 1_700_000_010_000,
  source: "ui",
  namedHostId: "host-1",
  effectiveModelId: "claude-haiku-4.5",
} as EvalSuiteRun;

function renderSuitePage(
  overrides: Partial<Parameters<typeof SuiteDetailOverview>[0]> = {},
) {
  const props = {
    projectId: "project-1",
    suite,
    cases: [testCase],
    runs: [run],
    runsLoading: false,
    metricsByRun: metricsByRunFromIterations([]),
    hostNamesById: new Map([["host-1", "MCPJam"]]),
    onRerun: vi.fn(),
    onEditSuite: vi.fn(),
    onSetupSdk: vi.fn(),
    onEditCases: vi.fn(),
    onRunClick: vi.fn(),
    onTestCaseClick: vi.fn(),
    rerunningSuiteId: null,
    ...overrides,
  };
  renderWithProviders(<SuiteDetailOverview {...props} />);
  return props;
}

beforeEach(() => {
  mocks.open.mockClear();
  mocks.track.mockClear();
});

describe("Suite page with the flag on", () => {
  it("shows results only, with Export as SDK, Suite settings and Run", async () => {
    const user = userEvent.setup();
    const props = renderSuitePage();
    expect(screen.getByTestId("suite-detail-run-history")).toBeVisible();
    expect(screen.queryByTestId("suite-detail-test-cases")).toBeNull();
    expect(screen.queryByText("Configure suite evaluators")).toBeNull();
    expect(screen.queryByRole("button", { name: "Setup Run" })).toBeNull();
    expect(screen.getByRole("button", { name: "Run" })).toBeEnabled();
    expect(screen.getByTestId("suite-detail-pills")).toHaveTextContent(
      "MCPJam",
    );

    await user.click(screen.getByRole("button", { name: "Export as SDK" }));
    expect(props.onSetupSdk).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Suite settings" }));
    expect(mocks.open).toHaveBeenCalledWith(
      { type: "suite-settings", suiteId: "suite-1", tab: "settings" },
      "suite",
    );
    expect(mocks.track).toHaveBeenCalledWith("eval_nav_page_viewed", {
      page: "suite",
      arrived_via: "direct",
      location: "evaluate",
    });
  });

  it("opens a run as its own page, remembering the suite as the way back", async () => {
    const user = userEvent.setup();
    const props = renderSuitePage();
    await user.click(screen.getByTestId("suite-run-row-run-6"));
    expect(mocks.open).toHaveBeenCalledWith(
      { type: "run-detail", suiteId: "suite-1", runId: "run-6" },
      "suite",
    );
    expect(props.onRunClick).not.toHaveBeenCalled();
  });

  it("points an empty suite at Suite settings instead of authoring here", async () => {
    const user = userEvent.setup();
    renderSuitePage({ cases: [], runs: [] });
    expect(screen.queryByTestId("suite-detail-empty-cases")).toBeNull();
    expect(screen.getByText("No test cases yet")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add test cases" }));
    expect(mocks.open).toHaveBeenCalledWith(
      { type: "suite-settings", suiteId: "suite-1", tab: "cases" },
      "suite",
    );
  });

  it("says a suite with cases has not run yet", () => {
    renderSuitePage({ runs: [] });
    expect(screen.getByText("No runs yet")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add test cases" })).toBeNull();
  });

  it("offers no Suite settings to a read-only reader", () => {
    renderSuitePage({ readOnlyConfig: true });
    expect(screen.queryByRole("button", { name: "Suite settings" })).toBeNull();
  });
});
