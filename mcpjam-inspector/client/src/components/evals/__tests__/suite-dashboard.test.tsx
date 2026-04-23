import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
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
  it("renders run insights directly under the chart grid, before cases and runs columns", () => {
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
    const cases = screen.getByTestId("cases-overview");

    expect(
      chart.compareDocumentPosition(insights) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      insights.compareDocumentPosition(cases) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
