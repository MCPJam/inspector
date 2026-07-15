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

vi.mock("../test-cases-overview", () => ({
  TestCasesOverview: () => <div data-testid="cases-overview" />,
}));

// SuiteResultsSplit pulls `computeRunEffectiveStats` from this module for the
// rail; the component itself is no longer rendered by SuiteDashboard.
vi.mock("../suite-runs-list", () => ({
  SuiteRunsList: () => <div data-testid="runs-list" />,
  computeRunEffectiveStats: () => ({
    effectivePassed: 0,
    effectiveTotal: 0,
    passRate: null,
  }),
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
  it("renders the results split (run rail) as the default surface — no tabs", () => {
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

    // The run rail (master) + compare affordance, not a Runs/Cases tablist.
    expect(screen.getByText("latest + trends per client")).toBeInTheDocument();
    expect(screen.getByText(/Compare runs/i)).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();

    // Run insights persists above the split when runs exist.
    expect(screen.getByText("Run insights")).toBeInTheDocument();
  });

  it("falls back to the case library in the All-runs pane (no host-scoped data)", () => {
    // This suite has no host attachments, so the matrix has nothing to show and
    // the All-runs pane degrades to the authoring case library.
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

    expect(screen.getByTestId("cases-overview")).toBeInTheDocument();
  });

  it("renders the case library and no Run insights before any runs exist", () => {
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

    expect(screen.getByTestId("cases-overview")).toBeInTheDocument();
    expect(screen.queryByText("Run insights")).not.toBeInTheDocument();
  });
});
