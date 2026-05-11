import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SuiteRunRegressionSummary } from "../suite-run-regression-summary";
import type { EvalIteration } from "../types";

function it_(
  testCaseId: string,
  result: EvalIteration["result"],
  provider = "anthropic",
  model = "claude-haiku",
): EvalIteration {
  return {
    _id: Math.random().toString(36).slice(2),
    testCaseId,
    projectId: "p",
    testCaseSnapshot: {
      title: "t",
      query: "q",
      provider,
      model,
      expectedToolCalls: [],
    } as unknown as EvalIteration["testCaseSnapshot"],
    suiteRunId: "sr",
    createdBy: "u",
    createdAt: 0,
    iterationNumber: 1,
    updatedAt: 0,
    status: "completed",
    result,
    actualToolCalls: [],
    tokensUsed: 0,
  } as EvalIteration;
}

describe("SuiteRunRegressionSummary", () => {
  it("renders nothing when there is no overlap and nothing added/removed", () => {
    const { container } = render(
      <SuiteRunRegressionSummary
        currentIterations={[]}
        previousIterations={[]}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders an all-clear status when comparable pairs exist but none regressed", () => {
    const prev = [it_("tc1", "passed"), it_("tc1", "passed")];
    const cur = [it_("tc1", "passed"), it_("tc1", "passed")];
    render(
      <SuiteRunRegressionSummary
        currentIterations={cur}
        previousIterations={prev}
        thresholdPct={10}
      />,
    );
    expect(
      screen.getByText(/no regressions vs previous run/i),
    ).toBeInTheDocument();
  });

  it("renders flagged regressions with previous → current pass rates", () => {
    const prev = [
      it_("tc1", "passed"),
      it_("tc1", "passed"),
      it_("tc1", "passed"),
      it_("tc1", "passed"),
      it_("tc1", "passed"),
    ];
    const cur = [
      it_("tc1", "passed"),
      it_("tc1", "failed"),
      it_("tc1", "failed"),
      it_("tc1", "failed"),
      it_("tc1", "failed"),
    ];
    render(
      <SuiteRunRegressionSummary
        currentIterations={cur}
        previousIterations={prev}
        thresholdPct={10}
        titleByCaseId={{ tc1: "search-issues case" }}
      />,
    );
    expect(
      screen.getByText(/1 regression vs previous run/i),
    ).toBeInTheDocument();
    expect(screen.getByText("search-issues case")).toBeInTheDocument();
    expect(screen.getByText(/100% → 20%/)).toBeInTheDocument();
  });
});
