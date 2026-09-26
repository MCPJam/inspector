import { computeIterationResult } from "./pass-criteria";
import {
  iterationLatencyP50,
  iterationLatencyP95,
  percentile,
} from "./helpers";
import type { EvalIteration, EvalRunMetrics, EvalSuiteRun } from "./types";

/**
 * Per-run metrics for the suite page.
 *
 * The suite page renders its run history from ONE metrics object per run
 * instead of folding every iteration of the suite in the browser. That object
 * is the server rollup (`testSuiteRun.metrics`, written at terminal) when the
 * run has a usable one, and otherwise a fold of that run's own iterations —
 * loaded per run, never for the whole suite at once.
 *
 * `runMetricsFromIterations` is that client fold. It mirrors the backend fold
 * (`convex/lib/evalRunMetrics.ts`) field for field, so a row reads the same
 * whichever side computed it.
 */

const ACTIVE_RUN_STATUSES = new Set(["pending", "running", "grading"]);

export function isActiveRun(run: Pick<EvalSuiteRun, "status">): boolean {
  return ACTIVE_RUN_STATUSES.has(run.status);
}

/**
 * True when the server rollup cannot stand in for the run's iterations:
 * the run is still moving, it finished before the rollup existed, or some of
 * its iterations carry no stored verdict (only the browser's tool-call matcher
 * can grade those, so the server's pass counts would be short).
 */
export function runNeedsIterationFold(run: EvalSuiteRun): boolean {
  if (isActiveRun(run)) return true;
  if (!run.metrics) return true;
  return run.metrics.results.unscored > 0;
}

function durationMs(iteration: EvalIteration): number | null {
  const start = iteration.startedAt;
  const end = iteration.updatedAt;
  if (typeof start !== "number" || typeof end !== "number") return null;
  if (end < start) return null;
  return end - start;
}

/** A client-side fold also keeps its raw durations, for exact pooling. */
export type RunMetrics = EvalRunMetrics & { durationsMs?: number[] };

export function runMetricsFromIterations(
  iterations: readonly EvalIteration[],
): RunMetrics {
  const results = {
    passed: 0,
    failed: 0,
    timedOut: 0,
    cancelled: 0,
    pending: 0,
    setupFailed: 0,
    skipped: 0,
    unscored: 0,
  };
  const durationsMs: number[] = [];
  let tokensTotal = 0;
  let tokensMeasuredIterations = 0;
  let toolCallsTotal = 0;
  let toolCallsMeasuredIterations = 0;
  let costUsd = 0;
  let costedIterations = 0;
  let hasRunnerReportedCost = false;
  const models = new Map<string, EvalRunMetrics["models"][number]>();

  for (const iteration of iterations) {
    const result = computeIterationResult(iteration);
    const bucket =
      result === "timed_out"
        ? "timedOut"
        : result === "setup_failed"
          ? "setupFailed"
          : result;
    results[bucket] += 1;

    if (iteration.status === "completed") {
      const duration = durationMs(iteration);
      if (duration !== null) durationsMs.push(duration);
    }
    if (
      typeof iteration.tokensUsed === "number" &&
      Number.isFinite(iteration.tokensUsed)
    ) {
      tokensTotal += iteration.tokensUsed;
      tokensMeasuredIterations += 1;
    }
    if (iteration.actualToolCalls) {
      toolCallsTotal += iteration.actualToolCalls.length;
      toolCallsMeasuredIterations += 1;
    }
    const cost = iteration.usage?.estimatedCostUsd;
    if (typeof cost === "number") {
      costUsd += cost;
      costedIterations += 1;
      if (iteration.usage?.costBasis?.source === "sdk_runner") {
        hasRunnerReportedCost = true;
      }
    }
    const model = iteration.testCaseSnapshot?.model?.trim();
    if (model) {
      const row = models.get(model) ?? {
        model,
        total: 0,
        passed: 0,
        failed: 0,
        timedOut: 0,
      };
      row.total += 1;
      if (result === "passed") row.passed += 1;
      else if (result === "failed") row.failed += 1;
      else if (result === "timed_out") row.timedOut += 1;
      models.set(model, row);
    }
  }

  const latencyP50Ms = iterationLatencyP50([...iterations]);
  const latencyP95Ms = iterationLatencyP95([...iterations]);
  return {
    version: 1,
    iterationCount: iterations.length,
    results,
    completedCount: durationsMs.length,
    ...(latencyP50Ms !== null ? { latencyP50Ms } : {}),
    ...(latencyP95Ms !== null ? { latencyP95Ms } : {}),
    ...(tokensMeasuredIterations > 0 ? { tokensTotal } : {}),
    tokensMeasuredIterations,
    ...(toolCallsMeasuredIterations > 0 ? { toolCallsTotal } : {}),
    toolCallsMeasuredIterations,
    ...(costedIterations > 0 ? { costUsd } : {}),
    costedIterations,
    hasRunnerReportedCost,
    models: [...models.values()],
    durationsMs,
  };
}

/** Fold loaded iterations into one metrics object per run they belong to. */
export function metricsByRunFromIterations(
  iterations: readonly EvalIteration[],
): Map<string, RunMetrics> {
  const byRun = new Map<string, EvalIteration[]>();
  for (const iteration of iterations) {
    if (!iteration.suiteRunId) continue;
    const rows = byRun.get(iteration.suiteRunId);
    if (rows) rows.push(iteration);
    else byRun.set(iteration.suiteRunId, [iteration]);
  }
  return new Map(
    [...byRun].map(([runId, rows]) => [runId, runMetricsFromIterations(rows)]),
  );
}

/**
 * The metrics a run is shown with: the server rollup when it can stand in,
 * else a fold of the run's loaded iterations, else `null` (still loading).
 */
export function resolveRunMetrics(
  run: EvalSuiteRun,
  iterations: readonly EvalIteration[] | undefined,
): RunMetrics | null {
  if (!runNeedsIterationFold(run) && run.metrics) return run.metrics;
  if (iterations) return runMetricsFromIterations(iterations);
  // A settled run whose rollup is only short on legacy verdicts still has
  // every other number right; show those while its iterations load.
  return run.metrics ?? null;
}

export type RunMetricsByRun = ReadonlyMap<string, RunMetrics>;

/**
 * Pass/fail counts the way `computeRunEffectiveStats` reads them: only
 * decided iterations (passed + failed; a timeout is not a verdict), falling
 * back to the stored summary while nothing has been decided.
 */
export function computeRunEffectiveStatsFromMetrics(
  run: EvalSuiteRun,
  metrics: RunMetrics | null | undefined,
): {
  effectivePassed: number;
  effectiveTotal: number;
  passRate: number | null;
} {
  const passed = metrics?.results.passed ?? 0;
  const failed = metrics?.results.failed ?? 0;
  const completedTotal = passed + failed;
  const effectivePassed =
    completedTotal > 0 ? passed : (run.summary?.passed ?? 0);
  const effectiveTotal =
    completedTotal > 0 ? completedTotal : (run.summary?.total ?? 0);
  const passRate =
    effectiveTotal > 0
      ? Math.round((effectivePassed / effectiveTotal) * 100)
      : null;
  return { effectivePassed, effectiveTotal, passRate };
}

/**
 * p50/p95 across several runs.
 *
 * Exact when every run carries its raw durations (a client fold). Otherwise
 * the server stored only each run's own p50/p95, and percentiles do not
 * compose — so this is the median (p95) of the per-run values, weighted by
 * each run's completed-iteration count. Close for runs of similar shape; it is
 * an approximation, and the header labels it no differently than before.
 */
export function poolLatency(list: readonly (RunMetrics | null | undefined)[]): {
  latencyP50: number | null;
  latencyP95: number | null;
} {
  const present = list.filter(
    (metrics): metrics is RunMetrics =>
      metrics != null && metrics.completedCount > 0,
  );
  if (present.length === 0) return { latencyP50: null, latencyP95: null };
  if (present.every((metrics) => metrics.durationsMs)) {
    const all = present.flatMap((metrics) => metrics.durationsMs ?? []);
    return {
      latencyP50: percentile(all, 0.5),
      latencyP95: percentile(all, 0.95),
    };
  }
  return {
    latencyP50: weightedPercentile(present, "latencyP50Ms", 0.5),
    latencyP95: weightedPercentile(present, "latencyP95Ms", 0.95),
  };
}

function weightedPercentile(
  list: readonly RunMetrics[],
  key: "latencyP50Ms" | "latencyP95Ms",
  p: number,
): number | null {
  const samples = list
    .map((metrics) => ({ value: metrics[key], weight: metrics.completedCount }))
    .filter(
      (sample): sample is { value: number; weight: number } =>
        typeof sample.value === "number" && sample.weight > 0,
    )
    .sort((a, b) => a.value - b.value);
  if (samples.length === 0) return null;
  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  const target = totalWeight * p;
  let running = 0;
  for (const sample of samples) {
    running += sample.weight;
    if (running >= target) return sample.value;
  }
  return samples[samples.length - 1].value;
}
