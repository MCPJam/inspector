import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { EvalIteration, EvalSuiteRun } from "../types";

vi.mock("../use-run-insights", () => ({
  useRunInsights: vi.fn(),
}));

import { useRunInsights } from "../use-run-insights";
import { RunDetailView } from "../run-detail-view";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn().mockResolvedValue(undefined),
  useQuery: () => undefined,
  useAction: () => vi.fn().mockResolvedValue(undefined),
}));

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user",
    runNumber: 1,
    configRevision: "rev1",
    configSnapshot: {
      tests: [],
      environment: { servers: [] },
    },
    status: "completed",
    createdAt: 1,
    completedAt: 2,
    summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
    ...overrides,
  };
}

function makeIteration(overrides: Partial<EvalIteration> = {}): EvalIteration {
  return {
    _id: "iter-1",
    createdBy: "user",
    createdAt: 1,
    iterationNumber: 1,
    updatedAt: 2,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 100,
    testCaseSnapshot: {
      title: "Test A",
      query: "q",
      provider: "openai",
      model: "gpt-4",
      expectedToolCalls: [],
    },
    ...overrides,
  };
}

const chartDataUsable = {
  donutData: [{ name: "passed", value: 1, fill: "green" }],
  durationData: [
    {
      name: "Short name",
      duration: 5000,
      durationSeconds: 5,
    },
  ],
  tokensData: [{ name: "Short name", tokens: 1200 }],
  modelData: [],
};

const emptyChartData = {
  donutData: [],
  durationData: [],
  tokensData: [],
  modelData: [],
};

function defaultRunInsightsReturn() {
  return {
    summary: null as string | null,
    pending: false,
    requested: false,
    failedGeneration: false,
    error: null as string | null,
    requestRunInsights: vi.fn(),
    cancelRunInsights: vi.fn(),
    unavailable: false,
    canRequest: true,
  };
}

describe("RunDetailView", () => {
  beforeEach(() => {
    vi.mocked(useRunInsights).mockReturnValue(defaultRunInsightsReturn());
  });

  it("keeps bar charts inside one in-card collapsible; expanding shows both charts", () => {
    render(
      <RunDetailView
        selectedRunDetails={makeRun()}
        caseGroupsForSelectedRun={[makeIteration()]}
        source="ui"
        selectedRunChartData={chartDataUsable}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
      />,
    );

    const section = screen.getByRole("button", {
      name: /Duration and token charts/i,
    });
    const collapsibleRoot = section.closest('[data-slot="collapsible"]');
    expect(
      collapsibleRoot?.querySelectorAll('[data-slot="chart"]').length,
    ).toBe(0);

    fireEvent.click(section);

    expect(
      collapsibleRoot?.querySelectorAll('[data-slot="chart"]').length,
    ).toBe(2);
    expect(
      screen.getByRole("heading", { name: "Avg duration by test" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Avg tokens by test" }),
    ).toBeVisible();
  });

  it("hides run-level Run insights card when an iteration is selected", () => {
    render(
      <RunDetailView
        selectedRunDetails={makeRun()}
        caseGroupsForSelectedRun={[makeIteration()]}
        source="ui"
        selectedRunChartData={chartDataUsable}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId="iter-1"
        onSelectIteration={() => {}}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /Duration and token charts/i }),
    ).not.toBeInTheDocument();
  });

  it("hides chart section when there is no duration or token data", () => {
    render(
      <RunDetailView
        selectedRunDetails={makeRun()}
        caseGroupsForSelectedRun={[makeIteration()]}
        source="ui"
        selectedRunChartData={{
          donutData: [{ name: "passed", value: 1, fill: "green" }],
          durationData: [],
          tokensData: [{ name: "x", tokens: 0 }],
          modelData: [],
        }}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /Duration and token charts/i }),
    ).not.toBeInTheDocument();
  });

  it("shows case insight summary when selected iteration matches caseKey", () => {
    const iter = makeIteration({
      _id: "iter-case",
      testCaseId: "tc-1",
      testCaseSnapshot: {
        title: "Test A",
        query: "q",
        provider: "openai",
        model: "gpt-4",
        expectedToolCalls: [],
        caseKey: "ck-match",
      },
    });
    const run = makeRun({
      runInsights: {
        summary: "suite level",
        generatedAt: 1,
        modelUsed: "m",
        caseInsights: [
          {
            caseKey: "ck-match",
            testCaseId: "tc-1",
            title: "t",
            status: "new_failure",
            summary: "Matched case summary text",
          },
        ],
      },
    });
    render(
      <RunDetailView
        selectedRunDetails={run}
        caseGroupsForSelectedRun={[iter]}
        source="ui"
        selectedRunChartData={emptyChartData}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId="iter-case"
        onSelectIteration={() => {}}
      />,
    );
    expect(
      screen.getByTestId("run-case-insight-trace-caption"),
    ).toBeInTheDocument();
    expect(screen.getByText("Matched case summary text")).toBeVisible();
  });

  it("shows no notable change when there is no matching case insight row", () => {
    const iter = makeIteration({
      _id: "iter-x",
      testCaseId: "tc-1",
      testCaseSnapshot: {
        title: "Test A",
        query: "q",
        provider: "openai",
        model: "gpt-4",
        expectedToolCalls: [],
        caseKey: "ck-other",
      },
    });
    const run = makeRun({
      runInsights: {
        summary: "s",
        generatedAt: 1,
        modelUsed: "m",
        caseInsights: [
          {
            caseKey: "unrelated",
            testCaseId: "other-id",
            title: "t",
            status: "fixed",
            summary: "should not show",
          },
        ],
      },
    });
    render(
      <RunDetailView
        selectedRunDetails={run}
        caseGroupsForSelectedRun={[iter]}
        source="ui"
        selectedRunChartData={emptyChartData}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId="iter-x"
        onSelectIteration={() => {}}
      />,
    );
    expect(
      screen.queryByTestId("run-case-insight-trace-caption"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("No notable change in the last two runs."),
    ).not.toBeInTheDocument();
  });

  it("shows generating state when run insights are pending", () => {
    vi.mocked(useRunInsights).mockReturnValue({
      ...defaultRunInsightsReturn(),
      pending: true,
    });
    const iter = makeIteration({ _id: "iter-p" });
    render(
      <RunDetailView
        selectedRunDetails={makeRun()}
        caseGroupsForSelectedRun={[iter]}
        source="ui"
        selectedRunChartData={emptyChartData}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId="iter-p"
        onSelectIteration={() => {}}
      />,
    );
    const caption = screen.getByTestId("run-case-insight-trace-caption");
    expect(
      within(caption).getByText("Generating insights…"),
    ).toBeVisible();
  });

  it("shows failed generation copy on case block when insights failed", () => {
    vi.mocked(useRunInsights).mockReturnValue({
      ...defaultRunInsightsReturn(),
      failedGeneration: true,
    });
    const iter = makeIteration({ _id: "iter-f" });
    render(
      <RunDetailView
        selectedRunDetails={makeRun()}
        caseGroupsForSelectedRun={[iter]}
        source="ui"
        selectedRunChartData={emptyChartData}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId="iter-f"
        onSelectIteration={() => {}}
      />,
    );
    expect(
      screen.getByText("Run insights did not complete. Use Retry above."),
    ).toBeVisible();
  });

  it("shows complete-the-run copy when run is not completed", () => {
    const iter = makeIteration({ _id: "iter-run" });
    render(
      <RunDetailView
        selectedRunDetails={makeRun({ status: "running" })}
        caseGroupsForSelectedRun={[iter]}
        source="ui"
        selectedRunChartData={emptyChartData}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId="iter-run"
        onSelectIteration={() => {}}
      />,
    );
    expect(
      screen.getByText(
        "Complete the run to generate diff insights for this case.",
      ),
    ).toBeVisible();
  });

  it("does not render case insight block when no iteration is selected", () => {
    render(
      <RunDetailView
        selectedRunDetails={makeRun()}
        caseGroupsForSelectedRun={[makeIteration()]}
        source="ui"
        selectedRunChartData={emptyChartData}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
      />,
    );
    expect(
      screen.queryByTestId("run-case-insight-trace-caption"),
    ).not.toBeInTheDocument();
  });
});
