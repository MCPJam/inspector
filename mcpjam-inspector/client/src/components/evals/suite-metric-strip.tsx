import { useMemo } from "react";
import { MetricStrip } from "./metric-strip";
import {
  buildAggregateMetricStripData,
  buildSuiteMetricStripData,
  formatMetricStripCollapsedSummary,
} from "./metric-strip-data";
import { SuiteDashboardCollapsibleSection } from "./suite-dashboard-collapsible-section";
import type { EvalIteration, EvalSuiteRun } from "./types";

/**
 * Suite header health band. Thin wrapper around the shared MetricStrip fed by
 * suite-run time series.
 */
export function SuiteMetricStrip({
  runs,
  allIterations,
  aggregate = false,
}: {
  runs: EvalSuiteRun[];
  allIterations: EvalIteration[];
  /**
   * Fold the runs into a single point-in-time aggregate (no trend) instead of a
   * per-run time series. Used when the header is scoped to one run group.
   */
  aggregate?: boolean;
}) {
  const data = useMemo(
    () =>
      aggregate
        ? buildAggregateMetricStripData(runs, allIterations)
        : buildSuiteMetricStripData(runs, allIterations),
    [runs, allIterations, aggregate],
  );

  const collapsedSummary = useMemo(
    () => (data ? formatMetricStripCollapsedSummary(data) : null),
    [data],
  );

  if (!data) return null;

  return (
    <SuiteDashboardCollapsibleSection
      label="Metrics"
      summary={collapsedSummary}
      variant="card"
      testId="suite-metric-strip-collapsible"
    >
      <MetricStrip
        data={data}
        density="default"
        surface="embedded"
        testId="suite-metric-strip"
      />
    </SuiteDashboardCollapsibleSection>
  );
}
