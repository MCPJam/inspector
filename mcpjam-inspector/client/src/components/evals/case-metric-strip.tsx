import { useMemo } from "react";
import { MetricStrip } from "./metric-strip";
import { buildCaseMetricStripData } from "./metric-strip-data";
import type { CaseRunBatch } from "./runs/group-case-iterations";

/** Case editor Runs tab header — same strip as the suite dashboard, scoped to one case's run batches. */
export function CaseMetricStrip({ batches }: { batches: CaseRunBatch[] }) {
  const data = useMemo(() => buildCaseMetricStripData(batches), [batches]);
  return (
    <MetricStrip data={data} density="compact" testId="case-metric-strip" />
  );
}
