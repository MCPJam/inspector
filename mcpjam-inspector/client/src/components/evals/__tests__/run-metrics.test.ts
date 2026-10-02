import { describe, expect, it } from "vitest";
import {
  computeRunEffectiveStatsFromMetrics,
  poolLatency,
  resolveRunMetrics,
  runMetricsFromIterations,
  runNeedsIterationFold,
  type RunMetrics,
} from "../run-metrics";
import type { EvalIteration, EvalRunMetrics, EvalSuiteRun } from "../types";

function iteration(partial: Partial<EvalIteration>): EvalIteration {
  return {
    _id: "it",
    suiteRunId: "run-1",
    status: "completed",
    result: "passed",
    tokensUsed: 10,
    actualToolCalls: [{ toolName: "t", arguments: {} }],
    startedAt: 1_000,
    updatedAt: 2_000,
    testCaseSnapshot: {
      title: "case",
      query: "q",
      provider: "anthropic",
      model: "claude",
      expectedToolCalls: [],
    },
    ...partial,
  } as unknown as EvalIteration;
}

function run(partial: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-1",
    status: "completed",
    ...partial,
  } as unknown as EvalSuiteRun;
}

function serverMetrics(partial: Partial<EvalRunMetrics> = {}): EvalRunMetrics {
  return {
    version: 1,
    iterationCount: 4,
    results: {
      passed: 3,
      failed: 1,
      timedOut: 0,
      cancelled: 0,
      pending: 0,
      setupFailed: 0,
      skipped: 0,
      unscored: 0,
    },
    completedCount: 4,
    latencyP50Ms: 100,
    latencyP95Ms: 200,
    tokensTotal: 40,
    tokensMeasuredIterations: 4,
    toolCallsTotal: 4,
    toolCallsMeasuredIterations: 4,
    costedIterations: 0,
    hasRunnerReportedCost: false,
    models: [],
    ...partial,
  };
}

describe("runMetricsFromIterations", () => {
  // Same scenario as the backend fold's test (`convex/__tests__/
  // evalRunMetrics.test.ts`): the two sides must count alike.
  it("maps results the way the backend fold does", () => {
    const metrics = runMetricsFromIterations([
      iteration({}),
      iteration({ result: "failed" }),
      iteration({ status: "timed_out", result: "timed_out" }),
      iteration({ status: "cancelled", result: "cancelled" }),
      iteration({ status: "running", result: "pending" }),
      iteration({ status: "setup_failed", result: "failed" }),
      iteration({ status: "skipped", result: "pending" }),
      iteration({
        status: "running",
        result: "passed",
        resultSource: "reported",
      }),
    ]);
    expect(metrics.results).toEqual({
      passed: 2,
      failed: 1,
      timedOut: 1,
      cancelled: 1,
      pending: 1,
      setupFailed: 1,
      skipped: 1,
      unscored: 0,
    });
    expect(metrics.iterationCount).toBe(8);
  });

  it("sums tokens, tool calls, and cost with their coverage", () => {
    const metrics = runMetricsFromIterations([
      iteration({ usage: { estimatedCostUsd: 0.25 } as never }),
      iteration({
        tokensUsed: 5,
        actualToolCalls: [],
        usage: {
          estimatedCostUsd: 0.5,
          costBasis: { status: "estimated", source: "sdk_runner" },
        } as never,
      }),
    ]);
    expect(metrics.tokensTotal).toBe(15);
    expect(metrics.toolCallsTotal).toBe(1);
    expect(metrics.costUsd).toBe(0.75);
    expect(metrics.costedIterations).toBe(2);
    expect(metrics.hasRunnerReportedCost).toBe(true);
    expect(metrics.models).toEqual([
      { model: "claude", total: 2, passed: 2, failed: 0, timedOut: 0 },
    ]);
  });
});

describe("resolveRunMetrics", () => {
  it("uses the server rollup for a settled run", () => {
    const stored = serverMetrics();
    expect(resolveRunMetrics(run({ metrics: stored }), undefined)).toBe(stored);
    expect(runNeedsIterationFold(run({ metrics: stored }))).toBe(false);
  });

  it("folds the run's rows while it is still moving", () => {
    const live = run({ status: "running", metrics: serverMetrics() });
    expect(runNeedsIterationFold(live)).toBe(true);
    expect(resolveRunMetrics(live, [iteration({})])?.iterationCount).toBe(1);
  });

  it("folds legacy runs that have no rollup, and waits while they load", () => {
    expect(runNeedsIterationFold(run())).toBe(true);
    expect(resolveRunMetrics(run(), undefined)).toBeNull();
  });

  it("folds when the rollup could not grade some rows", () => {
    const partial = serverMetrics({
      results: { ...serverMetrics().results, unscored: 1 },
    });
    expect(runNeedsIterationFold(run({ metrics: partial }))).toBe(true);
    // Until the rows arrive, the rollup's other numbers still stand.
    expect(resolveRunMetrics(run({ metrics: partial }), undefined)).toBe(
      partial,
    );
  });
});

describe("computeRunEffectiveStatsFromMetrics", () => {
  it("counts decided trials only, and falls back to the summary", () => {
    expect(
      computeRunEffectiveStatsFromMetrics(run(), serverMetrics()).passRate,
    ).toBe(75);
    expect(
      computeRunEffectiveStatsFromMetrics(
        run({ summary: { total: 2, passed: 1, failed: 1, passRate: 0.5 } }),
        null,
      ),
    ).toEqual({ effectivePassed: 1, effectiveTotal: 2, passRate: 50 });
  });
});

describe("poolLatency", () => {
  it("is exact when every run kept its durations", () => {
    const a = runMetricsFromIterations([
      iteration({ startedAt: 0, updatedAt: 100 }),
      iteration({ startedAt: 0, updatedAt: 300 }),
    ]);
    const b = runMetricsFromIterations([
      iteration({ startedAt: 0, updatedAt: 200 }),
    ]);
    expect(poolLatency([a, b]).latencyP50).toBe(200);
  });

  it("weights per-run values by completed trials for server rollups", () => {
    const small: RunMetrics = serverMetrics({
      completedCount: 1,
      latencyP50Ms: 1_000,
      latencyP95Ms: 1_000,
    });
    const large: RunMetrics = serverMetrics({
      completedCount: 9,
      latencyP50Ms: 100,
      latencyP95Ms: 150,
    });
    expect(poolLatency([small, large])).toEqual({
      latencyP50: 100,
      latencyP95: 1_000,
    });
    expect(poolLatency([])).toEqual({ latencyP50: null, latencyP95: null });
  });
});
