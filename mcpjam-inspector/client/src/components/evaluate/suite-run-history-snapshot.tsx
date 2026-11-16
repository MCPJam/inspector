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
import { historyResult } from "./evaluate-history-row";
import { isSubsetRerunRun } from "../evals/helpers";
import { isActiveRun } from "../evals/run-metrics";
import { SUITE_METRIC_HINTS } from "./nav-suite/suite-page-hints";

/** One launch on the suite's history, oldest first. */
export type SuiteHistoryLaunch = {
  /** The metric strip's point; null until the launch has metrics. */
  point: MetricStripPoint | null;
  label: string;
  /** The launch's first member run: what a click on the launch opens. */
  runId: string;
  suiteId: string;
  runNumber: number;
  date: number;
  /** The runs table's verdict for the launch: "Running", "Passed", "Failed"… */
  verdict: string;
  /** Scored trials toward the suite's health; null when the launch counts for none. */
  health: { passed: number; total: number } | null;
};

/**
 * The dashboard's rule (`buildSuiteHealth`): first keep the runs that count (no
 * "rerun failed cases" rerun, no inconclusive run, only what the filters
 * match); the launch is off the trend while any of those is still running.
 * Only scored trials count.
 */
function launchHealth(
  members: readonly EvalSuiteRunListItem[],
  metricsByRun: RunMetricsByRun,
  countsRun?: (runId: string) => boolean,
): SuiteHistoryLaunch["health"] {
  const counted = members.filter(
    (member) =>
      !isSubsetRerunRun(member) &&
      member.result !== "inconclusive" &&
      (!countsRun || countsRun(member._id)),
  );
  if (counted.some(isActiveRun)) return null;
  let passed = 0;
  let total = 0;
  for (const member of counted) {
    const results = metricsByRun.get(member._id)?.results;
    if (!results) continue;
    passed += results.passed;
    total += results.passed + results.failed + results.timedOut;
  }
  return total ? { passed, total } : null;
}

/**
 * Every launch, oldest first. `countsRun` narrows health to the runs the Runs
 * card's filters keep, so a launch's other clients do not move its bar.
 */
export function buildSuiteHistoryLaunches(
  runs: readonly EvalSuiteRunListItem[],
  metricsByRun: RunMetricsByRun,
  countsRun?: (runId: string) => boolean,
): SuiteHistoryLaunch[] {
  const seen = new Set<string>();
  return [...runs]
    .sort((a, b) => runTimestamp(a) - runTimestamp(b))
    .flatMap((run): SuiteHistoryLaunch[] => {
      if (seen.has(run._id)) return [];
      const members = launchRuns(run, runs);
      members.forEach((member) => seen.add(member._id));
      const metrics =
        members.length === 1
          ? buildSuiteMetricStripDataFromMetrics(members, metricsByRun)
          : buildAggregateMetricStripDataFromMetrics(members, metricsByRun);
      const launch = {
        label: `#${members[0].runNumber}`,
        runId: members[0]._id,
        suiteId: members[0].suiteId,
        runNumber: members[0].runNumber,
        // The latest member's time: the runs table orders launches by it.
        date: Math.max(...members.map(runTimestamp)),
        verdict: historyResult(members),
        health: launchHealth(members, metricsByRun, countsRun),
      };
      if (!metrics) return [{ ...launch, point: null }];
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
          ...launch,
          point: total
            ? {
                ...metrics.latest,
                passed,
                failed,
                total,
                passRate: Math.round((passed / total) * 100),
              }
            : metrics.latest,
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
  nav?: {
    threshold: number | null;
    onOpenRun: (runId: string) => void;
    /** The runs the Runs card's filters keep, for the health row. */
    countsRun?: (runId: string) => boolean;
  };
}) {
  const countsRun = nav?.countsRun;
  const launches = useMemo(
    () => buildSuiteHistoryLaunches(runs, metricsByRun, countsRun),
    [runs, metricsByRun, countsRun],
  );
  const data = useMemo(() => {
    const measured = launches.filter((item) => item.point);
    const series = measured.map((item) => item.point!);
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
          runLabels: measured.map((item) => item.label),
        } satisfies MetricStripData)
      : null;
  }, [launches]);
  // The health row shows "No scored runs" even before any launch has metrics.
  if (!data && !nav) return null;
  return (
    <>
      {nav ? (
        <SuiteRunsHealth
          launches={launches}
          threshold={nav.threshold}
          onOpenRun={nav.onOpenRun}
        />
      ) : null}
      {data ? (
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
      ) : null}
    </>
  );
}
