import { useMemo } from "react";
import {
  resolveRunMetrics,
  runNeedsIterationFold,
  type RunMetrics,
} from "./run-metrics";
import { useProjectRunHistory } from "./use-project-run-history";
import type { EvalSuiteRun } from "./types";

/**
 * One metrics object per listed run, for the suite page's history views.
 *
 * Settled runs carry a server rollup and cost no extra reads. Only runs the
 * rollup cannot stand in for — still running, finished before the rollup
 * existed, or holding legacy rows only the browser can grade — are read one
 * run at a time through `useProjectRunHistory` (bounded concurrency, settled
 * runs cached for the session, live runs polled).
 */
export function useSuiteRunMetrics(
  projectId: string | null | undefined,
  runs: readonly EvalSuiteRun[] | undefined,
  enabled: boolean,
): { metricsByRun: ReadonlyMap<string, RunMetrics>; loading: boolean } {
  const foldRows = useMemo(
    () => (runs ?? []).filter(runNeedsIterationFold),
    [runs],
  );
  // The history hook keys its session cache by project; a suite with no
  // project still reads runs by id, so any stable key will do.
  const history = useProjectRunHistory(
    projectId ?? "no-project",
    foldRows,
    enabled,
  );

  const metricsByRun = useMemo(() => {
    const map = new Map<string, RunMetrics>();
    for (const run of runs ?? []) {
      const detail = history.details.get(run._id);
      const metrics = resolveRunMetrics(run, detail?.iterations);
      if (metrics) map.set(run._id, metrics);
    }
    return map;
  }, [runs, history.details]);

  return { metricsByRun, loading: history.loading };
}
