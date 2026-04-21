import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SuiteExecutionsOverview } from "../suite-executions-overview";
import { formatTime } from "../helpers";
import type { EvalCase, EvalIteration } from "../types";

const cases: EvalCase[] = [
  {
    _id: "case-1",
    testSuiteId: "suite-1",
    createdBy: "u",
    title: "Live case",
    query: "Prompt",
    models: [],
    runs: 1,
    expectedToolCalls: [],
  },
];

function iteration(overrides: Partial<EvalIteration>): EvalIteration {
  return {
    _id: "iter",
    testCaseId: "case-1",
    createdBy: "u",
    createdAt: 1,
    startedAt: 1,
    iterationNumber: 1,
    updatedAt: 1,
    status: "completed",
    result: "passed",
    actualToolCalls: [],
    tokensUsed: 0,
    ...overrides,
  } as EvalIteration;
}

describe("SuiteExecutionsOverview", () => {
  it("sorts executions by updatedAt, then startedAt, then createdAt", () => {
    render(
      <SuiteExecutionsOverview
        cases={cases}
        allIterations={[
          iteration({
            _id: "created",
            testCaseSnapshot: { title: "Created fallback" } as any,
            testCaseId: undefined,
            suiteRunId: "run-created",
            createdAt: 1000,
            startedAt: undefined,
            updatedAt: undefined as any,
          }),
          iteration({
            _id: "updated",
            testCaseSnapshot: { title: "Updated wins" } as any,
            testCaseId: undefined,
            suiteRunId: "run-updated",
            createdAt: 100,
            startedAt: 200,
            updatedAt: 3000,
          }),
          iteration({
            _id: "started",
            testCaseSnapshot: { title: "Started fallback" } as any,
            testCaseId: undefined,
            suiteRunId: "run-started",
            createdAt: 100,
            startedAt: 2000,
            updatedAt: undefined as any,
          }),
        ]}
        onOpenIteration={vi.fn()}
      />,
    );

    const rows = screen.getAllByTestId(/suite-execution-row-/);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Updated wins"),
      expect.stringContaining("Started fallback"),
      expect.stringContaining("Created fallback"),
    ]);
    expect(screen.getByText(formatTime(3000))).toBeInTheDocument();
    expect(screen.getByText(formatTime(2000))).toBeInTheDocument();
    expect(screen.getByText(formatTime(1000))).toBeInTheDocument();
  });

  it("uses the live test case name before snapshot fallback", () => {
    render(
      <SuiteExecutionsOverview
        cases={cases}
        allIterations={[
          iteration({
            _id: "live",
            testCaseSnapshot: { title: "Snapshot title" } as any,
          }),
        ]}
        onOpenIteration={vi.fn()}
      />,
    );

    expect(screen.getByText("Live case")).toBeInTheDocument();
    expect(screen.queryByText("Snapshot title")).toBeNull();
  });

  it("fires onOpenIteration when an openable row is clicked", async () => {
    const user = userEvent.setup();
    const onOpenIteration = vi.fn();
    const target = iteration({ _id: "click-target" });

    render(
      <SuiteExecutionsOverview
        cases={cases}
        allIterations={[target]}
        onOpenIteration={onOpenIteration}
      />,
    );

    await user.click(screen.getByTestId("suite-execution-row-click-target"));

    expect(onOpenIteration).toHaveBeenCalledWith(target);
  });
});
