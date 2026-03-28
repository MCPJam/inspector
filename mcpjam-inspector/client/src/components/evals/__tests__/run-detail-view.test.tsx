import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RunDetailView } from "../run-detail-view";
import type { EvalIteration, EvalSuiteRun } from "../types";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn().mockResolvedValue(undefined),
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

describe("RunDetailView", () => {
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
});
