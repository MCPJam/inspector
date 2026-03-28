import { describe, expect, it, vi } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { ExploreCasesList } from "../explore-cases-list";
import type { EvalCase, EvalIteration, SuiteAggregate } from "../types";

const baseCase: EvalCase = {
  _id: "case-1",
  testSuiteId: "suite-1",
  createdBy: "user-1",
  title: "Example case",
  query: "",
  models: [],
  runs: 0,
  expectedToolCalls: [],
  scenario: "",
  isNegativeTest: false,
};

function makeAggregate(failedForCase: number): SuiteAggregate {
  return {
    filteredIterations: [],
    totals: {
      passed: 0,
      failed: failedForCase,
      cancelled: 0,
      pending: 0,
      tokens: 0,
    },
    byCase: [
      {
        testCaseId: baseCase._id,
        title: baseCase.title,
        provider: "",
        model: "",
        runs: 0,
        passed: 0,
        failed: failedForCase,
        cancelled: 0,
        tokens: 0,
      },
    ],
  };
}

function makePendingIteration(
  overrides: Partial<EvalIteration> = {},
): EvalIteration {
  return {
    _id: "iter-1",
    suiteRunId: "run-1",
    testCaseId: baseCase._id,
    createdBy: "user-1",
    iterationNumber: 1,
    status: "running",
    result: "pending",
    resultSource: "reported",
    actualToolCalls: [],
    tokensUsed: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("ExploreCasesList", () => {
  it("sidebar row uses in-flight styling when latest is pending even if aggregate shows past failures", () => {
    const onRowClick = vi.fn();
    const { container } = renderWithProviders(
      <ExploreCasesList
        cases={[baseCase]}
        aggregate={makeAggregate(3)}
        iterations={[makePendingIteration()]}
        isLoading={false}
        onRowClick={onRowClick}
        variant="sidebar"
      />,
    );

    expect(
      container.querySelector("button.border-l-warning\\/50"),
    ).toBeTruthy();
    expect(
      container.querySelector("button.border-l-destructive\\/50"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /Example case/i }),
    ).toBeInTheDocument();
  });
});
