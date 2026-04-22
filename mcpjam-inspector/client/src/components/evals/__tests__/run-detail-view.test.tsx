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

  it("places single-row KPI dashboard above breakdown charts", () => {
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

    const durationChartHeading = screen.getByRole("heading", {
      name: "Avg duration by test",
    });
    const accuracyLabel = screen.getByText("Accuracy");
    const passRateCard = accuracyLabel.parentElement;
    expect(passRateCard).not.toBeNull();
    expect(
      within(passRateCard as HTMLElement).getByText("100%"),
    ).toBeInTheDocument();
    const kpiBlock = accuracyLabel.closest(".space-y-6");
    expect(kpiBlock).not.toBeNull();
    expect(
      within(kpiBlock as HTMLElement).getByText("Passed"),
    ).toBeInTheDocument();
    expect(
      within(kpiBlock as HTMLElement).getByText("Failed"),
    ).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("Duration")).toBeInTheDocument();
    expect(
      accuracyLabel.compareDocumentPosition(durationChartHeading) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    expect(durationChartHeading).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Avg tokens by test" }),
    ).toBeVisible();
    expect(
      document.querySelectorAll('[data-slot="chart"]').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("does not render compact run stats in a duplicate page header", () => {
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

    expect(screen.queryByText(/1 passed · 0 failed · 100%/)).not.toBeInTheDocument();
  });

  it("keeps run-level KPIs and bar charts visible above the iteration list", () => {
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

    const accuracyKpi = screen.getByText("Accuracy");
    expect(
      within(accuracyKpi.parentElement as HTMLElement).getByText("100%"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Avg duration by test" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Avg tokens by test" }),
    ).toBeInTheDocument();
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

  it("does not surface per-iteration case insight captions in the run view (open a test from the list to inspect a case)", () => {
    render(
      <RunDetailView
        selectedRunDetails={makeRun({
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
                summary: "Only shown in test editor or case detail, not run list",
              },
            ],
          },
        })}
        caseGroupsForSelectedRun={[
          makeIteration({
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
          }),
        ]}
        source="ui"
        selectedRunChartData={emptyChartData}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId="iter-case"
        onSelectIteration={() => {}}
      />,
    );
    expect(
      screen.queryByTestId("run-case-insight-trace-caption"),
    ).not.toBeInTheDocument();
  });

  it("shows pass rate in Overview sidebar row and not the full compact stats line", () => {
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
        name: /Overview — show in main panel — 86%/,
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

  it("uses the same “Last run” column label as the suite cases table in the iteration sidebar", () => {
    render(
      <RunIterationsSidebar
        caseGroupsForSelectedRun={[makeIteration()]}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
      />,
    );
    expect(screen.getByText("Case name")).toBeInTheDocument();
    expect(screen.getByText("Last run")).toBeInTheDocument();
  });

  it("keeps the main run list aligned with the suite cases table: no Overview row, sort in the header row", () => {
    render(
      <RunDetailView
        selectedRunDetails={makeRun({
          summary: { total: 7, passed: 6, failed: 1, passRate: 6 / 7 },
        })}
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
      screen.queryByRole("button", {
        name: /Overview — show in main panel/,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sort iterations: Test" }),
    ).toBeInTheDocument();
  });

  it("exposes view-iteration aria-label on the full iteration row button", () => {
    render(
      <RunIterationsSidebar
        caseGroupsForSelectedRun={[makeIteration()]}
        runDetailSortBy="test"
        onSortChange={() => {}}
        selectedIterationId={null}
        onSelectIteration={() => {}}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "View iteration details: Test A, Passed, gpt-4",
      }),
    ).toBeInTheDocument();
  });
});
