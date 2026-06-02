import { describe, expect, it, vi } from "vitest";
import { fireEvent, renderWithProviders, screen } from "@/test";
import { SuiteDashboard } from "../suite-dashboard";
import type { EvalSuite, EvalSuiteRun } from "../types";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn().mockResolvedValue(undefined),
  useQuery: () => undefined,
  useConvex: () => ({}),
}));

vi.mock("../use-run-insights", () => ({
  useRunInsights: () => ({
    summary: "Summary text",
    pending: false,
    failedGeneration: false,
    requestRunInsights: vi.fn(),
    unavailable: false,
    requested: true,
  }),
}));

vi.mock("../suite-runs-chart-grid", () => ({
  SuiteRunsChartGrid: () => <div data-testid="chart-grid" />,
}));

vi.mock("../test-cases-overview", () => ({
  TestCasesOverview: () => <div data-testid="cases-overview" />,
}));

vi.mock("../suite-runs-list", () => ({
  SuiteRunsList: () => <div data-testid="runs-list" />,
}));

const suite: EvalSuite = {
  _id: "suite-1",
  createdBy: "u1",
  name: "Suite",
  description: "",
  configRevision: "1",
  environment: { servers: [] },
  createdAt: 1,
  updatedAt: 1,
  source: "ui",
};

const completedRun: EvalSuiteRun = {
  _id: "run-a",
  suiteId: "suite-1",
  createdBy: "u1",
  runNumber: 1,
  configRevision: "1",
  configSnapshot: { tests: [], environment: { servers: [] } },
  status: "completed",
  createdAt: 1,
  completedAt: 2,
};

describe("SuiteDashboard", () => {
  it("renders chart and insights above the Runs/Cases tablist and defaults to Runs when runs exist", () => {
    renderWithProviders(
      <SuiteDashboard
        suite={suite}
        cases={[]}
        allIterations={[]}
        runs={[completedRun]}
        runsLoading={false}
        runTrendData={[]}
        modelStats={[]}
        onTestCaseClick={() => {}}
        onRunClick={() => {}}
      />,
    );

    const chart = screen.getByTestId("chart-grid");
    const insights = screen.getByRole("button", { name: /Run insights/i });
    const runsTab = screen.getByRole("tab", { name: /Runs/i });

    expect(
      chart.compareDocumentPosition(insights) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      insights.compareDocumentPosition(runsTab) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(runsTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("runs-list")).toBeInTheDocument();
    expect(screen.queryByTestId("cases-overview")).not.toBeInTheDocument();
  });

  it("defaults to Cases tab when no runs exist", () => {
    renderWithProviders(
      <SuiteDashboard
        suite={suite}
        cases={[]}
        allIterations={[]}
        runs={[]}
        runsLoading={false}
        runTrendData={[]}
        modelStats={[]}
        onTestCaseClick={() => {}}
        onRunClick={() => {}}
      />,
    );

    const casesTab = screen.getByRole("tab", { name: /Cases/i });
    expect(casesTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("cases-overview")).toBeInTheDocument();
    expect(screen.queryByTestId("runs-list")).not.toBeInTheDocument();
  });

  it("switches between Runs and Cases on tab click", () => {
    renderWithProviders(
      <SuiteDashboard
        suite={suite}
        cases={[]}
        allIterations={[]}
        runs={[completedRun]}
        runsLoading={false}
        runTrendData={[]}
        modelStats={[]}
        onTestCaseClick={() => {}}
        onRunClick={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /Cases/i }));
    expect(screen.getByTestId("cases-overview")).toBeInTheDocument();
    expect(screen.queryByTestId("runs-list")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Runs/i }));
    expect(screen.getByTestId("runs-list")).toBeInTheDocument();
    expect(screen.queryByTestId("cases-overview")).not.toBeInTheDocument();
  });
});
