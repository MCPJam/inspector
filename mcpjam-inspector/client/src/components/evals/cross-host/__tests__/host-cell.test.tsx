import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EvalIteration } from "../../types";
import { HostCell } from "../host-cell";
import type { JudgeCase, WorkflowInsight } from "../../goal-completion-presentation";
import type { CellData, CellTrendPoint } from "../use-cross-host-data";

function makeIteration(id: string): EvalIteration {
  return {
    _id: id,
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 2,
    iterationNumber: 1,
    status: "completed",
    result: "passed",
    resultSource: "reported",
    actualToolCalls: [{ toolName: "search", arguments: {} }],
    tokensUsed: 1900,
    startedAt: 1,
  } as EvalIteration;
}

function trendPoint(
  id: string,
  result: CellTrendPoint["result"],
  latencyMs: number | null,
): CellTrendPoint {
  return {
    runId: id,
    runLabel: id.slice(-4),
    timestamp: 1,
    result,
    latencyMs,
    latencyP95Ms: latencyMs,
    tokens: 1900,
    toolCalls: 2,
  };
}

function makeCell(trendSeries?: CellTrendPoint[]): CellData {
  return {
    iterations: [makeIteration("i1")],
    passCount: 1,
    failCount: 0,
    pendingCount: 0,
    totalCount: 1,
    passRate: 100,
    p50LatencyMs: 10_000,
    p95LatencyMs: 10_000,
    avgTokensPerIteration: 1900,
    trendSeries,
  };
}

describe("HostCell", () => {
  it("renders snapshot metrics when trendSeries is absent", () => {
    render(<HostCell data={makeCell()} />);
    expect(screen.getByText("Pass")).toBeInTheDocument();
    expect(screen.getByText("p50")).toBeInTheDocument();
    expect(screen.queryByTestId("cell-metric-strip")).not.toBeInTheDocument();
  });

  it("has no insight toggle when there is no judge/workflow data", () => {
    render(<HostCell data={makeCell()} />);
    expect(
      screen.queryByRole("button", { name: /show cell insight/i }),
    ).not.toBeInTheDocument();
  });

  it("expands a per-cell insight (judge + workflow + trace link)", async () => {
    const user = userEvent.setup();
    const onOpenTrace = vi.fn();
    render(
      <HostCell
        data={makeCell()}
        judgeCase={
          {
            caseKey: "case-1",
            score: 0.55,
            passed: false,
            reason: "Reported Coke instead of Red Bull.",
            rubricHits: [],
          } as JudgeCase
        }
        workflowInsight={
          {
            caseKey: "case-1",
            title: "Show me a redbull",
            toolCallCount: 4,
            efficiency: "inefficient",
            issues: ["Over-searched."],
            suggestions: [],
          } as WorkflowInsight
        }
        onOpenTrace={onOpenTrace}
      />,
    );
    // Collapsed by default — reason not shown yet.
    expect(
      screen.queryByText("Reported Coke instead of Red Bull."),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /show cell insight/i }),
    );
    expect(
      screen.getByText("Reported Coke instead of Red Bull."),
    ).toBeInTheDocument();
    expect(screen.getByText("inefficient")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /view trace/i }));
    expect(onOpenTrace).toHaveBeenCalledTimes(1);
  });

  it("renders labeled metric strip when trendSeries has at least two points", () => {
    render(
      <HostCell
        trendsLayout
        data={makeCell([
          trendPoint("run-old", "passed", 8000),
          trendPoint("run-new", "passed", 10_000),
        ])}
      />,
    );
    expect(screen.getByTestId("cell-metric-strip")).toBeInTheDocument();
    expect(screen.getByText("All passing")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText("Latency")).toBeInTheDocument();
    expect(screen.getByText("9.00s")).toBeInTheDocument();
    expect(screen.getByText("9.90s")).toBeInTheDocument();
    expect(screen.getByText("Tokens")).toBeInTheDocument();
    expect(screen.getByText("Tool calls")).toBeInTheDocument();
    expect(screen.getByTestId("metric-sparkline-pass-rate")).toBeInTheDocument();
    expect(screen.getByTestId("metric-sparkline-latency")).toBeInTheDocument();
    expect(screen.queryByText("p50")).not.toBeInTheDocument();
  });

  it("uses metric strip layout with a single run when trendsLayout is on", () => {
    render(
      <HostCell
        trendsLayout
        data={makeCell([trendPoint("run-only", "passed", 8000)])}
      />,
    );
    expect(screen.getByTestId("cell-metric-strip")).toBeInTheDocument();
    expect(screen.getByText("Latency")).toBeInTheDocument();
    expect(screen.queryByTestId("metric-sparkline-pass-rate")).not.toBeInTheDocument();
    expect(screen.queryByText("p50")).not.toBeInTheDocument();
  });

  it("falls back to snapshot when trendSeries has only one point and trendsLayout is off", () => {
    render(
      <HostCell data={makeCell([trendPoint("run-only", "passed", 8000)])} />,
    );
    expect(screen.queryByTestId("cell-metric-strip")).not.toBeInTheDocument();
    expect(screen.getByText("p50")).toBeInTheDocument();
  });

  it("uses metric strip for snapshot-only cells when trendsLayout is on", () => {
    render(<HostCell trendsLayout data={makeCell()} />);
    expect(screen.getByTestId("cell-metric-strip")).toBeInTheDocument();
    expect(screen.getByText("All passing")).toBeInTheDocument();
    expect(screen.queryByText("p50")).not.toBeInTheDocument();
  });

  it("shows Running (not Fail) while iterations are still pending", () => {
    render(
      <HostCell
        data={{
          ...makeCell(),
          passCount: 0,
          failCount: 0,
          pendingCount: 1,
          totalCount: 1,
          passRate: null,
        }}
      />,
    );
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.queryByText("Fail")).not.toBeInTheDocument();
  });

  it("shows Fail once a completed iteration has failed", () => {
    render(
      <HostCell
        data={{
          ...makeCell(),
          passCount: 0,
          failCount: 1,
          pendingCount: 0,
          totalCount: 1,
          passRate: 0,
        }}
      />,
    );
    expect(screen.getByText("Fail")).toBeInTheDocument();
  });

  it("shows a labeled empty state for cells with no data", () => {
    render(<HostCell data={undefined} />);
    expect(screen.getByTestId("host-cell-empty")).toBeInTheDocument();
    expect(screen.getByText("Not run")).toBeInTheDocument();
    expect(
      screen.getByText("This client has not run this case yet"),
    ).toBeInTheDocument();
  });

  it("uses a taller empty state in trends layout", () => {
    render(<HostCell data={undefined} trendsLayout />);
    expect(screen.getByTestId("host-cell-empty")).toHaveClass("min-h-[11rem]");
  });
});
