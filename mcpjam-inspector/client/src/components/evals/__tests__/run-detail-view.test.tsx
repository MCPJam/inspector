import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EvalIteration, EvalSuiteRun } from "../types";

vi.mock("../use-run-insights", () => ({
  useRunInsights: vi.fn(),
}));

import { useRunInsights } from "../use-run-insights";
import { RunDetailView, RunIterationsSidebar } from "../run-detail-view";

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

  it("places single-row KPI dashboard above the narrative and keeps breakdown charts below", () => {
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

    const narrative = screen.getByText(
      "We will add a short summary here when you open a completed run.",
    );
    const accuracyLabel = screen.getByText("Accuracy");
    const passRateCard = accuracyLabel.parentElement;
    expect(passRateCard).not.toBeNull();
    expect(
      within(passRateCard as HTMLElement).getByText("100%"),
    ).toBeInTheDocument();
    expect(screen.getByText("1 of 1 tests passed")).toBeInTheDocument();
    expect(screen.getByText("Passed")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Duration")).toBeInTheDocument();
    expect(
      accuracyLabel.compareDocumentPosition(narrative) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("Breakdown")).toBeVisible();

    expect(
      screen.getByRole("heading", { name: "Avg duration by test" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Avg tokens by test" }),
    ).toBeVisible();
    expect(document.querySelectorAll('[data-slot="chart"]').length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it("does not render compact run stats in the run insights header", () => {
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

    const header = screen.getByText("Run insights").parentElement;
    expect(header).not.toBeNull();
    expect(
      within(header as HTMLElement).queryByText(/1 passed · 0 failed · 100%/),
    ).not.toBeInTheDocument();
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

  it("shows pass rate in Run Insights sidebar row and not the full compact stats line", () => {
    const run = makeRun({
      summary: { total: 7, passed: 6, failed: 1, passRate: 6 / 7 },
    });
    render(
      <RunIterationsSidebar
        caseGroupsForSelectedRun={[]}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
        runForOverview={run}
        onOpenRunInsights={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: /Run Insights — show in main panel — 86%/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("86%")).toBeInTheDocument();
    expect(
      screen.queryByText(/6 passed · 1 failed · 86%/),
    ).not.toBeInTheDocument();
  });

  it("shows iteration sort options from an icon dropdown", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();

    render(
      <RunIterationsSidebar
        caseGroupsForSelectedRun={[makeIteration()]}
        runDetailSortBy="test"
        onSortChange={onSortChange}
        selectedIterationId={null}
        onSelectIteration={() => {}}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Sort iterations: Test" }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Result" }),
    );

    expect(onSortChange).toHaveBeenCalledWith("result");
  });
});
