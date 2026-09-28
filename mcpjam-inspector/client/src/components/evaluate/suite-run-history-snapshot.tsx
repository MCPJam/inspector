import { useMemo } from "react";
import { launchRuns } from "./run-results-matrix-model";
import {
  buildSuiteMetricStripDataFromMetrics,
  buildAggregateMetricStripDataFromMetrics,
} from "../evals/metric-strip-data";
import type { MetricStripData } from "../evals/metric-strip-data";
import { MetricStrip } from "../evals/metric-strip";
import type { RunMetricsByRun } from "../evals/run-metrics";
import type { EvalSuiteRun } from "../evals/types";
import { runTimestamp } from "./suite-detail-model";

/** Latest run metrics and run-history trends, sharing the original metric strip. */
export function SuiteRunHistorySnapshot({
  runs,
  metricsByRun,
}: {
  runs: readonly EvalSuiteRun[];
  /** One metrics object per run — see `evals/run-metrics.ts`. */
  metricsByRun: RunMetricsByRun;
}) {
  const data = useMemo(() => {
    const seen = new Set<string>();
    const points = [...runs]
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
          failed +=
            memberMetrics.results.failed + memberMetrics.results.timedOut;
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
          },
        ];
      });
    const series = points.map((item) => item.point);
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
          runLabels: points.map((item) => item.label),
        } satisfies MetricStripData)
      : null;
  }, [runs, metricsByRun]);
  if (!data) return null;
  return (
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
      />
    </div>
  );
}
