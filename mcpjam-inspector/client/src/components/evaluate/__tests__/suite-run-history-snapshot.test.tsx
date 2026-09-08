import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SuiteRunHistorySnapshot } from "../suite-run-history-snapshot";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";

function run(partial: Partial<EvalSuiteRun>): EvalSuiteRun {
  return { _id: "run-1", createdAt: 1_000, ...partial } as unknown as EvalSuiteRun;
}

function iteration(partial: Partial<EvalIteration>): EvalIteration {
  return {
    _id: "it",
    suiteRunId: "run-1",
    result: "passed",
    status: "completed",
    tokensUsed: 0,
    actualToolCalls: [],
    startedAt: 0,
    updatedAt: 0,
    ...partial,
  } as unknown as EvalIteration;
}

describe("SuiteRunHistorySnapshot", () => {
  it("renders nothing when there is no measured run", () => {
    const { container } = render(
      <SuiteRunHistorySnapshot runs={[]} allIterations={[]} />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("suite-metric-strip")).toBeNull();
  });

  it("shows the latest run the same way the legacy strip does", () => {
    render(
      <SuiteRunHistorySnapshot
        runs={[
          run({
            _id: "run-2",
            createdAt: 2_000,
            summary: { total: 2, passed: 1, failed: 1, passRate: 50 },
          }),
        ]}
        allIterations={[
          iteration({
            _id: "a",
            suiteRunId: "run-2",
            result: "passed",
            tokensUsed: 1000,
            actualToolCalls: [{ toolName: "x", arguments: {} }],
            startedAt: 1_000_000,
            updatedAt: 1_002_000,
          }),
          iteration({
            _id: "b",
            suiteRunId: "run-2",
            result: "failed",
            tokensUsed: 1500,
            actualToolCalls: [
              { toolName: "x", arguments: {} },
              { toolName: "y", arguments: {} },
            ],
            startedAt: 1_000_000,
            updatedAt: 1_004_000,
          }),
        ]}
      />,
    );

    const root = screen.getByTestId("suite-run-history-snapshot");
    expect(screen.queryByTestId("suite-metric-strip")).toBeNull();
    expect(within(root).getByText("1 failing")).toBeTruthy();
    expect(within(root).getByText("50%")).toBeTruthy();
    expect(within(root).getByText("1/2 passed")).toBeTruthy();
    expect(within(root).getByText("latest run")).toBeTruthy();

    const latency = within(root).getByTestId(
      "suite-run-history-snapshot-latency",
    );
    expect(within(latency).getByText("P50")).toBeTruthy();
    expect(within(latency).getByText("P95")).toBeTruthy();
    expect(within(latency).getByText("3.00s")).toBeTruthy();
    expect(within(latency).getByText("3.90s")).toBeTruthy();
    expect(within(root).getByText("1.3k")).toBeTruthy();
    expect(within(root).getByText("3")).toBeTruthy();
    expect(within(root).getAllByText("per run")).toHaveLength(3);
  });

  it("names the latest run against the series length", () => {
    render(
      <SuiteRunHistorySnapshot
        runs={[
          run({
            _id: "old",
            createdAt: 1,
            summary: { total: 1, passed: 1, failed: 0, passRate: 100 },
          }),
          run({
            _id: "new",
            createdAt: 2,
            summary: { total: 1, passed: 0, failed: 1, passRate: 0 },
          }),
        ]}
        allIterations={[
          iteration({
            _id: "i-old",
            suiteRunId: "old",
            result: "passed",
          }),
          iteration({
            _id: "i-new",
            suiteRunId: "new",
            result: "failed",
          }),
        ]}
      />,
    );

    expect(screen.getByText("latest of 2 runs")).toBeTruthy();
    expect(screen.getByText("0%")).toBeTruthy();
  });
});
