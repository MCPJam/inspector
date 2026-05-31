import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { SuiteDashboardMatrix } from "../suite-dashboard-matrix";
import type { SuiteDashboardMatrixData } from "../suite-dashboard-data";

const matrix: SuiteDashboardMatrixData = {
  latestCompletedRun: {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user-1",
    runNumber: 3,
    configRevision: "1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    createdAt: 1,
    completedAt: 2,
  },
  latestRunIterations: [],
  caseIds: ["case-1", "case-2"],
  modelKeys: ["openai/gpt-4o-mini", "anthropic/claude-haiku-4-5"],
  availableMetrics: ["pass-rate", "latency", "tokens", "validators"],
  caseRows: [
    { caseId: "case-1", title: "Create a diagram" },
    { caseId: "case-2", title: "Search shapes" },
  ],
  modelColumns: [
    { modelKey: "openai/gpt-4o-mini", modelLabel: "gpt-4o-mini" },
    {
      modelKey: "anthropic/claude-haiku-4-5",
      modelLabel: "claude-haiku-4-5",
    },
  ],
  cells: [
    {
      caseId: "case-1",
      modelKey: "openai/gpt-4o-mini",
      passed: 7,
      failed: 3,
      total: 10,
      passRate: 0.7,
      p50Ms: 1200,
      p95Ms: 2400,
      tokensUsed: 4200,
      inputTokens: 1200,
      outputTokens: 3000,
      validatorCount: 0,
      iterationResults: [
        "pass",
        "pass",
        "pass",
        "pass",
        "pass",
        "pass",
        "pass",
        "fail",
        "fail",
        "fail",
      ],
    },
    {
      caseId: "case-1",
      modelKey: "anthropic/claude-haiku-4-5",
      passed: 0,
      failed: 0,
      total: 0,
      passRate: null,
      p50Ms: null,
      p95Ms: null,
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      validatorCount: 0,
      iterationResults: [],
    },
    {
      caseId: "case-2",
      modelKey: "openai/gpt-4o-mini",
      passed: 4,
      failed: 6,
      total: 10,
      passRate: 0.4,
      p50Ms: 1800,
      p95Ms: 3200,
      tokensUsed: 5100,
      inputTokens: 2100,
      outputTokens: 3000,
      validatorCount: 2,
      iterationResults: [
        "pass",
        "pass",
        "pass",
        "pass",
        "fail",
        "fail",
        "fail",
        "fail",
        "fail",
        "fail",
      ],
    },
    {
      caseId: "case-2",
      modelKey: "anthropic/claude-haiku-4-5",
      passed: 0,
      failed: 0,
      total: 0,
      passRate: null,
      p50Ms: null,
      p95Ms: null,
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      validatorCount: 0,
      iterationResults: [],
    },
  ],
  modelAggregates: [
    {
      modelKey: "openai/gpt-4o-mini",
      passed: 11,
      failed: 9,
      total: 20,
      passRate: 0.55,
      p50Ms: 1500,
      p95Ms: 3000,
      tokensUsed: 9300,
      inputTokens: 3300,
      outputTokens: 6000,
      validatorCount: 2,
    },
    {
      modelKey: "anthropic/claude-haiku-4-5",
      passed: 0,
      failed: 0,
      total: 0,
      passRate: null,
      p50Ms: null,
      p95Ms: null,
      tokensUsed: 0,
      inputTokens: 0,
      outputTokens: 0,
      validatorCount: 0,
    },
  ],
};

describe("SuiteDashboardMatrix", () => {
  it("renders case names and model headers", () => {
    renderWithProviders(<SuiteDashboardMatrix matrix={matrix} />);

    expect(screen.getByText("Create a diagram")).toBeInTheDocument();
    expect(screen.getByText("Search shapes")).toBeInTheDocument();
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument();
    expect(screen.getByText("claude-haiku-4-5")).toBeInTheDocument();
    expect(screen.getByText(/last run · #3/i)).toBeInTheDocument();
  });

  it("renders passed/total summaries for populated cells", () => {
    renderWithProviders(<SuiteDashboardMatrix matrix={matrix} />);

    expect(screen.getAllByText("7/10").length).toBeGreaterThan(0);
    expect(screen.getAllByText("4/10").length).toBeGreaterThan(0);
  });

  it("renders empty cells when a model has no iterations for a case", () => {
    renderWithProviders(<SuiteDashboardMatrix matrix={matrix} />);

    const emptyCell = screen.getByTestId(
      "matrix-cell-case-1-anthropic/claude-haiku-4-5",
    );
    expect(emptyCell).toHaveTextContent("—");
  });

  it("renders token and validator summaries when data exists", () => {
    renderWithProviders(<SuiteDashboardMatrix matrix={matrix} />);

    const populatedCell = screen.getByTestId(
      "matrix-cell-case-2-openai/gpt-4o-mini",
    );
    expect(populatedCell).toHaveTextContent("5.1k");
    expect(populatedCell).toHaveTextContent("2 flags");

    const cleanCell = screen.getByTestId(
      "matrix-cell-case-1-openai/gpt-4o-mini",
    );
    expect(cleanCell).toHaveTextContent("clean");
  });

  it("renders aggregate pass percentages per model", () => {
    renderWithProviders(<SuiteDashboardMatrix matrix={matrix} />);

    const aggregateCell = screen.getByTestId(
      "matrix-aggregate-openai/gpt-4o-mini",
    );
    expect(aggregateCell).toHaveTextContent("55%");
    expect(aggregateCell).toHaveTextContent("11/20");
  });
});
