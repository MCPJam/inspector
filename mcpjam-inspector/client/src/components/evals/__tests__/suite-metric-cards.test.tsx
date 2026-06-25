import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { SuiteMetricStrip } from "../suite-metric-strip";
import type { EvalIteration, EvalSuiteRun } from "../types";

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

describe("SuiteMetricStrip", () => {
  it("renders nothing when there are no runs", () => {
    const { container } = render(
      <SuiteMetricStrip runs={[]} allIterations={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("aggregates the latest run's iterations into the four metrics", () => {
    const runs = [
      run({
        _id: "run-2",
        createdAt: 2_000,
        summary: { total: 2, passed: 1, failed: 1, passRate: 50 },
      }),
    ];
    const iterations = [
      iteration({
        _id: "a",
        suiteRunId: "run-2",
        result: "passed",
        tokensUsed: 1000,
        actualToolCalls: [{ toolName: "x", arguments: {} }],
        startedAt: 1_000_000,
        updatedAt: 1_002_000, // 2s
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
        updatedAt: 1_004_000, // 4s
      }),
    ];

    render(<SuiteMetricStrip runs={runs} allIterations={iterations} />);
    const root = screen.getByTestId("suite-metric-strip");

    // Pass rate from the run summary.
    expect(within(root).getByText("50%")).toBeInTheDocument();
    expect(within(root).getByText("1/2 passed")).toBeInTheDocument();
    // Latency p50/p95 for 2s and 4s case durations.
    const latency = within(root).getByTestId("metric-strip-latency");
    expect(within(latency).getByText("P50")).toBeInTheDocument();
    expect(within(latency).getByText("P95")).toBeInTheDocument();
    expect(within(latency).getByText("3.00s")).toBeInTheDocument();
    expect(within(latency).getByText("3.90s")).toBeInTheDocument();
    // Tokens: avg of 1k and 1.5k across two iterations in the run.
    expect(within(root).getByText("1.3k")).toBeInTheDocument();
    // Tool calls: sum of 1 + 2 across two iterations in the run.
    expect(within(root).getByText("3")).toBeInTheDocument();
    expect(within(root).getAllByText("per run")).toHaveLength(3);
  });

  it("sums tool calls across all cases in the latest run", () => {
    const runs = [run({ _id: "run-1", createdAt: 1_000 })];
    const iterations = [
      iteration({
        _id: "a",
        suiteRunId: "run-1",
        actualToolCalls: [{ toolName: "x", arguments: {} }],
      }),
      iteration({
        _id: "b",
        suiteRunId: "run-1",
        actualToolCalls: [
          { toolName: "x", arguments: {} },
          { toolName: "y", arguments: {} },
        ],
      }),
      iteration({ _id: "c", suiteRunId: "run-1", actualToolCalls: [] }),
    ];

    render(<SuiteMetricStrip runs={runs} allIterations={iterations} />);
    const root = screen.getByTestId("suite-metric-strip");

    expect(within(root).getByText("3")).toBeInTheDocument();
  });

  it("shows tool calls per run from the latest run with a per-run trend", () => {
    const runs = [
      run({ _id: "run-1", createdAt: 1_000 }),
      run({ _id: "run-2", createdAt: 2_000 }),
    ];
    const iterations = [
      iteration({
        _id: "a",
        suiteRunId: "run-1",
        actualToolCalls: [{ toolName: "x", arguments: {} }],
      }),
      iteration({
        _id: "b",
        suiteRunId: "run-2",
        actualToolCalls: [
          { toolName: "x", arguments: {} },
          { toolName: "y", arguments: {} },
        ],
      }),
    ];

    render(<SuiteMetricStrip runs={runs} allIterations={iterations} />);
    const root = screen.getByTestId("suite-metric-strip");

    expect(within(root).getByText("2")).toBeInTheDocument();
    expect(within(root).getAllByText("per run")).toHaveLength(3);
  });

  it("shows tokens per run from the latest run with a per-run trend", () => {
    const runs = [
      run({ _id: "run-1", createdAt: 1_000 }),
      run({ _id: "run-2", createdAt: 2_000 }),
    ];
    const iterations = [
      iteration({ _id: "a", suiteRunId: "run-1", tokensUsed: 10_000 }),
      iteration({ _id: "b", suiteRunId: "run-2", tokensUsed: 20_000 }),
    ];

    render(<SuiteMetricStrip runs={runs} allIterations={iterations} />);
    const root = screen.getByTestId("suite-metric-strip");

    // Latest run (run-2) used 20k tokens in its single iteration.
    expect(within(root).getByText("20k")).toBeInTheDocument();
    expect(within(root).getAllByText("per run")).toHaveLength(3);
  });

  it("renders no sparklines with a single run (nothing to trend)", () => {
    const runs = [run({ _id: "run-1", createdAt: 1000 })];
    const iterations = [iteration({ _id: "it-0", suiteRunId: "run-1" })];
    render(<SuiteMetricStrip runs={runs} allIterations={iterations} />);
    const root = screen.getByTestId("suite-metric-strip");
    expect(root.querySelectorAll("svg")).toHaveLength(0);
  });

  it("renders a sparkline per card once there are at least two runs", () => {
    const runs = [1, 2].map((n) =>
      run({ _id: `run-${n}`, createdAt: n * 1000 }),
    );
    const iterations = runs.map((r, i) =>
      iteration({
        _id: `it-${i}`,
        suiteRunId: r._id,
        startedAt: 0,
        updatedAt: (i + 1) * 1000,
      }),
    );
    render(<SuiteMetricStrip runs={runs} allIterations={iterations} />);
    const root = screen.getByTestId("suite-metric-strip");
    // A sparkline on each trend card (verdict + latency + tokens + tool calls).
    expect(root.querySelectorAll("svg")).toHaveLength(4);
  });

  it("aggregate mode folds a multi-host group into one point with no trend", () => {
    // A group launch = several host runs sharing a runGroupId. Aggregate mode
    // sums their summaries (not just the latest run) and draws no sparkline.
    const runs = [
      run({
        _id: "run-mcpjam",
        createdAt: 1_000,
        summary: { total: 9, passed: 5, failed: 4, passRate: 56 },
      }),
      run({
        _id: "run-chatgpt",
        createdAt: 1_100,
        summary: { total: 9, passed: 5, failed: 4, passRate: 56 },
      }),
      run({
        _id: "run-copilot",
        createdAt: 1_200,
        summary: { total: 9, passed: 5, failed: 4, passRate: 56 },
      }),
    ];
    const iterations = runs.map((r, i) =>
      iteration({ _id: `it-${i}`, suiteRunId: r._id }),
    );

    render(
      <SuiteMetricStrip runs={runs} allIterations={iterations} aggregate />,
    );
    const root = screen.getByTestId("suite-metric-strip");

    // 15/27 across the three hosts → 56%, not a single host's 5/9.
    expect(within(root).getByText("56%")).toBeInTheDocument();
    expect(within(root).getByText("15/27 passed")).toBeInTheDocument();
    // A group is a single launch — no per-host "trend".
    expect(root.querySelectorAll("svg")).toHaveLength(0);
  });

  it("skips a still-initializing latest run with no iterations and uses the prior run", () => {
    const runs = [
      run({ _id: "run-new", createdAt: 3_000 }), // no iterations yet
      run({
        _id: "run-old",
        createdAt: 2_000,
        summary: { total: 1, passed: 1, failed: 0, passRate: 100 },
      }),
    ];
    const iterations = [
      iteration({
        _id: "a",
        suiteRunId: "run-old",
        result: "passed",
        tokensUsed: 500,
        actualToolCalls: [],
        startedAt: 0,
        updatedAt: 1000,
      }),
    ];

    render(<SuiteMetricStrip runs={runs} allIterations={iterations} />);
    const root = screen.getByTestId("suite-metric-strip");
    expect(within(root).getByText("100%")).toBeInTheDocument();
    expect(within(root).getByText("1/1 passed")).toBeInTheDocument();
  });
});
