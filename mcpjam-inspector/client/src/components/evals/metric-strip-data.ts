import { computeIterationResult } from "./pass-criteria";
import {
  computeIterationSummary,
  iterationLatencyP50,
  iterationLatencyP95,
  percentile,
} from "./helpers";
import type { CaseRunBatch } from "./runs/group-case-iterations";
import type { EvalIteration, EvalSuiteRun } from "./types";

/** One run's aggregated metrics, in chronological order across the series. */
export interface MetricStripPoint {
  passRate: number;
  passed: number;
  total: number;
  failed: number;
  latencyP50: number | null;
  latencyP95: number | null;
  /** Average tokens per iteration (test execution) within this run/batch. */
  tokens: number;
  /** Total tool calls across all iterations in this run/batch. */
  toolCalls: number;
}

export interface MetricStripData {
  latest: MetricStripPoint;
  series: MetricStripPoint[];
  delta: number | null;
  showTrend: boolean;
  /** Tooltip / sparkline x-axis labels; defaults to Run 1, Run 2, … */
  runLabels?: string[];
}

/** One run in a matrix cell trend series (maps to MetricStripPoint). */
export type CellMetricTrendInput = {
  runLabel: string;
  result: "passed" | "failed" | "pending" | "partial";
  latencyMs: number | null;
  latencyP95Ms?: number | null;
  tokens: number | null;
  toolCalls?: number | null;
};

function passRateFromCellResult(
  result: CellMetricTrendInput["result"],
): number {
  if (result === "passed") return 100;
  if (result === "partial") return 50;
  return 0;
}

function metricPointFromCellTrend(point: CellMetricTrendInput): MetricStripPoint {
  const passed = point.result === "passed" ? 1 : 0;
  const failed = point.result === "failed" ? 1 : 0;
  return {
    passRate: passRateFromCellResult(point.result),
    passed,
    total: 1,
    failed,
    latencyP50: point.latencyMs,
    latencyP95: point.latencyP95Ms ?? point.latencyMs,
    tokens: point.tokens ?? 0,
    toolCalls: point.toolCalls ?? 0,
  };
}

function latencyPercentilesAcrossRuns(
  trendSeries: CellMetricTrendInput[],
): { latencyP50: number | null; latencyP95: number | null } {
  const p50Samples = trendSeries
    .map((point) => point.latencyMs)
    .filter((value): value is number => value != null);
  const p95Samples = trendSeries
    .map((point) => point.latencyP95Ms ?? point.latencyMs)
    .filter((value): value is number => value != null);

  return {
    latencyP50: percentile(p50Samples, 0.5),
    latencyP95: percentile(p95Samples, 0.95),
  };
}

/** Fold per-cell run history into the same strip model the suite header uses. */
export function buildCellMetricStripData(
  trendSeries: CellMetricTrendInput[],
): MetricStripData | null {
  if (trendSeries.length === 0) return null;

  const series = trendSeries.map(metricPointFromCellTrend);
  const base = finalizeMetricStripData(series);
  if (!base) return null;

  const { latencyP50, latencyP95 } = latencyPercentilesAcrossRuns(trendSeries);

  return {
    ...base,
    latest: {
      ...base.latest,
      latencyP50,
      latencyP95,
    },
    runLabels: trendSeries.map((point) => `Run ${point.runLabel}`),
  };
}

/** Render sparklines once there is a second point to compare against. */
export const MIN_TREND_POINTS = 2;

export function formatCompactNumber(value: number): string {
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1_000)
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (!Number.isInteger(value)) {
    return value.toFixed(1).replace(/\.0$/, "");
  }
  return String(value);
}

export function formatDurationMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)}s`;
  return `${Math.round(ms)}ms`;
}

function iterationToolCallCount(iteration: EvalIteration): number {
  return iteration.actualToolCalls?.length ?? 0;
}

function runToolCallTotal(iterations: EvalIteration[]): number {
  return iterations.reduce(
    (sum, iteration) => sum + iterationToolCallCount(iteration),
    0,
  );
}

function averageTokensPerIteration(iterations: EvalIteration[]): number {
  if (iterations.length === 0) return 0;
  const total = iterations.reduce((sum, it) => sum + (it.tokensUsed || 0), 0);
  return total / iterations.length;
}

function batchPassCounts(iterations: EvalIteration[]): {
  passed: number;
  failed: number;
  total: number;
} {
  const total = iterations.length;
  let passed = 0;
  let failed = 0;
  for (const iteration of iterations) {
    const result = computeIterationResult(iteration);
    if (result === "passed") passed += 1;
    else if (result === "failed") failed += 1;
  }
  return { passed, failed, total };
}

function pointFromIterations(
  iterations: EvalIteration[],
  summary?: { total: number; passed: number; failed: number },
): MetricStripPoint {
  const counts = summary ?? batchPassCounts(iterations);
  const { passed, failed, total } = counts;
  return {
    passRate: total > 0 ? Math.round((passed / total) * 100) : 0,
    passed,
    total,
    failed,
    latencyP50: iterationLatencyP50(iterations),
    latencyP95: iterationLatencyP95(iterations),
    tokens: averageTokensPerIteration(iterations),
    toolCalls: runToolCallTotal(iterations),
  };
}

function finalizeMetricStripData(series: MetricStripPoint[]): MetricStripData | null {
  if (series.length === 0) return null;

  const latest = series[series.length - 1];
  const prev = series.length >= 2 ? series[series.length - 2] : null;

  return {
    latest,
    series,
    delta: prev ? latest.passRate - prev.passRate : null,
    showTrend: series.length >= MIN_TREND_POINTS,
  };
}

export function buildSuiteMetricStripData(
  runs: EvalSuiteRun[],
  allIterations: EvalIteration[],
): MetricStripData | null {
  if (runs.length === 0) return null;

  const itsByRun = new Map<string, EvalIteration[]>();
  for (const it of allIterations) {
    if (!it.suiteRunId) continue;
    const arr = itsByRun.get(it.suiteRunId);
    if (arr) arr.push(it);
    else itsByRun.set(it.suiteRunId, [it]);
  }

  const chronological = [...runs].sort((a, b) => a.createdAt - b.createdAt);
  const series: MetricStripPoint[] = [];
  for (const run of chronological) {
    const its = itsByRun.get(run._id);
    if (!its || its.length === 0) continue;
    const summary = computeIterationSummary(its);
    const total = run.summary?.total ?? summary.runs;
    const passed = run.summary?.passed ?? summary.passed;
    const failed = run.summary?.failed ?? summary.failed;
    series.push(
      pointFromIterations(its, {
        total,
        passed,
        failed,
      }),
    );
  }

  return finalizeMetricStripData(series);
}

/**
 * Fold a set of runs into a SINGLE aggregated point (no trend). Used when the
 * header is scoped to one run group: a group is a single launch across N hosts,
 * so it reads as one point-in-time aggregate, not an N-point per-host "trend".
 */
export function buildAggregateMetricStripData(
  runs: EvalSuiteRun[],
  allIterations: EvalIteration[],
): MetricStripData | null {
  if (runs.length === 0) return null;

  const runIds = new Set(runs.map((r) => r._id));
  const iterations = allIterations.filter(
    (it) => it.suiteRunId && runIds.has(it.suiteRunId),
  );
  if (iterations.length === 0) return null;

  // Prefer the stored per-run summaries (authoritative pass/fail), summed across
  // the group; fall back to counting iterations when a run lacks a summary.
  let total = 0;
  let passed = 0;
  let failed = 0;
  let hasSummary = true;
  for (const run of runs) {
    if (run.summary) {
      total += run.summary.total;
      passed += run.summary.passed;
      failed += run.summary.failed;
    } else {
      hasSummary = false;
    }
  }

  const point = pointFromIterations(
    iterations,
    hasSummary ? { total, passed, failed } : undefined,
  );
  return finalizeMetricStripData([point]);
}

/** Fold case run batches into the same metric series the suite strip uses. */
export function buildCaseMetricStripData(
  batches: CaseRunBatch[],
): MetricStripData | null {
  if (batches.length === 0) return null;

  const chronological = [...batches].reverse();
  const series = chronological.map((batch) =>
    pointFromIterations(batch.iterations),
  );
  return finalizeMetricStripData(series);
}
