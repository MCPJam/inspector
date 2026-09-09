import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SuiteRunHistorySnapshot } from "../suite-run-history-snapshot";
import type { EvalIteration, EvalSuiteRun } from "../../evals/types";

function run(partial: Partial<EvalSuiteRun>): EvalSuiteRun {
  return {
    _id: "run-1",
    createdAt: 1_000,
    ...partial,
  } as unknown as EvalSuiteRun;
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
    expect(within(root).queryByText(/failed iteration/)).toBeNull();
    expect(within(root).getByText("50%")).toBeTruthy();
    expect(within(root).getByText("1/2 passed")).toBeTruthy();
    expect(within(root).queryByText("Latest run")).toBeNull();

    const latency = within(root).getByTestId("metric-strip-latency");
    expect(within(latency).getByText("P50")).toBeTruthy();
    expect(within(latency).getByText("P95")).toBeTruthy();
    expect(within(latency).getByText("3.00s")).toBeTruthy();
    expect(within(latency).getByText("3.90s")).toBeTruthy();
    expect(within(root).getByText("1.3k")).toBeTruthy();
    expect(within(root).getByText("3")).toBeTruthy();
    expect(within(root).getByText("latency / iteration")).toBeVisible();
    expect(within(root).getByText("avg tokens / iteration")).toBeVisible();
    expect(within(root).getByText("tool calls / run")).toBeVisible();
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

    expect(screen.queryByText(/Latest run/)).toBeNull();
    expect(screen.queryByText(/trends across/)).toBeNull();
    expect(screen.getByText("0%")).toBeTruthy();
  });
  it("shows measured history trends with real run labels and leaves unpriced cost blank", () => {
    const bounds = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockReturnValue({
        left: 0,
        width: 120,
        top: 0,
        right: 120,
        bottom: 24,
        height: 24,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
    try {
      render(
        <SuiteRunHistorySnapshot
          runs={[
            run({ _id: "new", runNumber: 9, createdAt: 3000 }),
            run({ _id: "missing", runNumber: 8, createdAt: 2000 }),
            run({ _id: "old", runNumber: 7, createdAt: 1000 }),
          ]}
          allIterations={[
            iteration({
              _id: "new-it",
              suiteRunId: "new",
              result: "failed",
              tokensUsed: 2000,
              startedAt: 1000,
              updatedAt: 5000,
            }),
            iteration({
              _id: "missing-it",
              suiteRunId: "missing",
              startedAt: undefined,
              updatedAt: undefined,
            }),
            iteration({
              _id: "old-it",
              suiteRunId: "old",
              tokensUsed: 1000,
              startedAt: 1000,
              updatedAt: 3000,
            }),
          ]}
        />,
      );
      for (const metric of ["pass-rate", "latency", "tokens", "tool-calls"]) {
        expect(
          screen.getByTestId(`metric-sparkline-${metric}`),
        ).toBeInTheDocument();
      }
      expect(screen.queryByTestId("metric-sparkline-cost")).toBeNull();
      expect(screen.getByText("not priced")).toBeVisible();
      expect(screen.queryByText(/ pp$/)).toBeNull();
      const latency = screen.getByTestId("metric-sparkline-latency");
      fireEvent.mouseMove(latency, { clientX: 0 });
      expect(within(latency).getByText(/Run #7/)).toBeVisible();
      expect(
        within(latency).getByTestId("metric-sparkline-tooltip-value"),
      ).toHaveTextContent("P50 2.00s · P95 2.00s");
      fireEvent.mouseMove(latency, { clientX: 60 });
      expect(within(latency).getByText(/Run #9/)).toBeVisible();
      expect(
        within(latency).getByTestId("metric-sparkline-tooltip-value"),
      ).toHaveTextContent("P50 4.00s · P95 4.00s");
    } finally {
      bounds.mockRestore();
    }
  });

  it("does not call unfinished iterations passed", () => {
    render(
      <SuiteRunHistorySnapshot
        runs={[
          run({ summary: { total: 2, passed: 0, failed: 0, passRate: 0 } }),
        ]}
        allIterations={[iteration({ result: "pending", status: "running" })]}
      />,
    );
    expect(screen.queryByText(/failed iteration/)).toBeNull();
    expect(screen.queryByText("All iterations passed")).toBeNull();
    expect(screen.getByText("0%")).toBeVisible();
    expect(screen.getByText("0/1 passed")).toBeVisible();
  });
});
