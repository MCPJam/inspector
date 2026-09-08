import { useMemo } from "react";
import { launchRuns, resultCounts } from "./run-results-matrix-model";
import {
  buildSuiteMetricStripData,
  buildAggregateMetricStripData,
} from "../evals/metric-strip-data";
import type { MetricStripData } from "../evals/metric-strip-data";
import { MetricStrip } from "../evals/metric-strip";
import type { EvalIteration, EvalSuiteRun } from "../evals/types";
import { runTimestamp } from "./suite-detail-model";

/** Latest run metrics and run-history trends, sharing the original metric strip. */
export function SuiteRunHistorySnapshot({
  runs,
  allIterations,
}: {
  runs: readonly EvalSuiteRun[];
  allIterations: readonly EvalIteration[];
}) {
  const data = useMemo(() => {
    const seen = new Set<string>();
    const points = [...runs]
      .sort((a, b) => runTimestamp(a) - runTimestamp(b))
      .flatMap((run) => {
        if (seen.has(run._id)) return [];
        const members = launchRuns(run, runs);
        members.forEach((member) => seen.add(member._id));
        const memberIds = new Set(members.map((member) => member._id));
        const items = allIterations.filter(
          (item) => item.suiteRunId != null && memberIds.has(item.suiteRunId),
        );
        const metrics =
          members.length === 1
            ? buildSuiteMetricStripData(members, items)
            : buildAggregateMetricStripData(members, items);
        if (!metrics) return [];
        const counts = resultCounts(items);
        return [
          {
            point: items.length
              ? {
                  ...metrics.latest,
                  passed: counts.passed,
                  failed: counts.failed,
                  total: items.length,
                  passRate: Math.round((counts.passed / items.length) * 100),
                }
              : metrics.latest,
            label: `Run #${members[0].runNumber}`,
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
  }, [runs, allIterations]);
  if (!data) return null;
  return (
    <div
      data-testid="suite-run-history-snapshot"
      className="@container/history-metrics border-b border-border/50"
    >
      <p className="px-5 pt-3 text-[10px] text-muted-foreground">
        {data.series.length === 1
          ? "Latest run"
          : `Latest run · trends across ${data.series.length} runs`}
      </p>
      <MetricStrip
        data={data}
        surface="embedded"
        context="history"
        testId="suite-run-history-metrics"
      />
    </div>
  );
}
