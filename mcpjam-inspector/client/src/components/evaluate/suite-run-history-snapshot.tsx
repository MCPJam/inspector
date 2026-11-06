import { useMemo } from "react";
import { launchRuns } from "./run-results-matrix-model";
import {
  buildSuiteMetricStripDataFromMetrics,
  buildAggregateMetricStripDataFromMetrics,
} from "../evals/metric-strip-data";
import type {
  MetricStripData,
  MetricStripPoint,
} from "../evals/metric-strip-data";
import { MetricStrip } from "../evals/metric-strip";
import type { RunMetricsByRun } from "../evals/run-metrics";
import type { EvalSuiteRunListItem } from "../evals/types";
import { runTimestamp } from "./suite-detail-model";
import { SuiteRunsHealth } from "./nav-suite/suite-runs-health";
import { SUITE_METRIC_HINTS } from "./nav-suite/suite-page-header";

/** One launch on the suite's history, oldest first. */
export type SuiteHistoryLaunch = {
  point: MetricStripPoint;
  label: string;
  /** The launch's first member run: what a click on the launch opens. */
  runId: string;
  suiteId: string;
  runNumber: number;
  date: number;
  /** "passed" only when every member run passed. */
  result: "passed" | "failed";
};

const launchOutcome = (run: EvalSuiteRunListItem) =>
  run.result && run.result !== "pending" ? run.result : run.status;

/** Per-launch history points; a launch without metrics yet is left out. */
export function buildSuiteHistoryLaunches(
  runs: readonly EvalSuiteRunListItem[],
  metricsByRun: RunMetricsByRun,
): SuiteHistoryLaunch[] {
  const seen = new Set<string>();
  return [...runs]
    .sort((a, b) => runTimestamp(a) - runTimestamp(b))
    .flatMap((run) => {
      if (seen.has(run._id)) return [];
      const members = launchRuns(run, runs);
      members.forEach((member) => seen.add(member._id));
      const metrics =
        members.length === 1
          ? buildSuiteMetricStripDataFromMetrics(members, metricsByRun)
          : buildAggregateMetricStripDataFromMetrics(members, metricsByRun);
      if (!metrics) return [];
      // `resultCounts` over the launch: a timeout counts as a failure, and
      // the denominator is every trial.
      let passed = 0;
      let failed = 0;
      let total = 0;
      for (const member of members) {
        const memberMetrics = metricsByRun.get(member._id);
        if (!memberMetrics) continue;
        passed += memberMetrics.results.passed;
        failed += memberMetrics.results.failed + memberMetrics.results.timedOut;
        total += memberMetrics.iterationCount;
      }
      return [
        {
          point: total
            ? {
                ...metrics.latest,
                passed,
                failed,
                total,
                passRate: Math.round((passed / total) * 100),
              }
            : metrics.latest,
          label: `#${members[0].runNumber}`,
          runId: members[0]._id,
          suiteId: members[0].suiteId,
          runNumber: members[0].runNumber,
          date: runTimestamp(members[0]),
          result: members.every((member) => launchOutcome(member) === "passed")
            ? "passed"
            : "failed",
        },
      ];
    });
}

/** Latest run metrics and run-history trends, sharing the original metric strip. */
export function SuiteRunHistorySnapshot({
  runs,
  metricsByRun,
  nav,
}: {
  runs: readonly EvalSuiteRunListItem[];
  /** One metrics object per run — see `evals/run-metrics.ts`. */
  metricsByRun: RunMetricsByRun;
  /** The new Suite page: health bars above a strip without its pass cell. */
  nav?: { threshold: number | null; onOpenRun: (runId: string) => void };
}) {
  const launches = useMemo(
    () => buildSuiteHistoryLaunches(runs, metricsByRun),
    [runs, metricsByRun],
  );
  const data = useMemo(() => {
    const series = launches.map((item) => item.point);
    return series.length
      ? ({
          latest: series[series.length - 1],
          series,
          delta:
            series.length > 1
              ? series[series.length - 1].passRate -
                series[series.length - 2].passRate
              : null,
          showTrend: series.length > 1,
          runLabels: launches.map((item) => item.label),
        } satisfies MetricStripData)
      : null;
  }, [launches]);
  if (!data) return null;
  return (
    <>
      {nav ? (
        <SuiteRunsHealth
          launches={launches}
          threshold={nav.threshold}
          onOpenRun={nav.onOpenRun}
        />
      ) : null}
      <div
        data-testid="suite-run-history-snapshot"
        className="@container/history-metrics border-b border-border/50"
      >
        <MetricStrip
          bars
          showCost={data.latest.costUsd != null}
          data={data}
          surface="embedded"
          context="history"
          testId="suite-run-history-metrics"
          {...(nav ? { hidePassRate: true, hints: SUITE_METRIC_HINTS } : {})}
        />
      </div>
    </>
  );
}
