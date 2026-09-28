import { useQueries } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useMemo } from "react";
import type { EvalIteration, EvalSuiteRun } from "./types";
import { launchRuns } from "../evaluate/run-results-matrix-model";
import {
  previousCompletedRunOf,
  previousLaunchRuns,
} from "../evaluate/run-verdict-hero-deltas";

const runDetailsQuery = makeFunctionReference<
  "query",
  { runId: string },
  { run: EvalSuiteRun; iterations: EvalIteration[] } | null
>("testSuites:getTestSuiteRunDetails");

export interface RunsIterations {
  /** Every loaded iteration of the requested runs, in run order. */
  iterations: EvalIteration[];
  byRun: ReadonlyMap<string, EvalIteration[]>;
  /** True while any requested run has not answered yet. */
  isLoading: boolean;
  /** Runs whose read failed (deleted, or access revoked). */
  failedRunIds: ReadonlySet<string>;
}

const EMPTY_ITERATIONS: EvalIteration[] = [];

/**
 * Live iterations for a handful of runs — the selected launch, the launch
 * before it, a case's winning runs. One subscription per run, so each read is
 * its own transaction bounded by ONE run's size rather than the suite's.
 *
 * Callers pass a small, stable set; this is not the way to load a whole
 * suite's history (that is `testSuiteRun.metrics`).
 */
export function useRunsIterations(
  runIds: readonly string[],
  enabled = true,
): RunsIterations {
  const key = enabled ? [...new Set(runIds)].sort().join(",") : "";
  // Convex keys its subscriptions by this object's identity; rebuild it only
  // when the requested set of runs actually changes.
  const queries = useMemo<Parameters<typeof useQueries>[0]>(() => {
    const request: Parameters<typeof useQueries>[0] = {};
    for (const runId of key ? key.split(",") : []) {
      request[runId] = { query: runDetailsQuery, args: { runId } };
    }
    return request;
  }, [key]);
  const results = useQueries(queries);

  return useMemo(() => {
    const byRun = new Map<string, EvalIteration[]>();
    const failedRunIds = new Set<string>();
    let isLoading = false;
    for (const runId of key ? key.split(",") : []) {
      const result = results[runId] as
        { iterations: EvalIteration[] } | null | Error | undefined;
      if (result === undefined) {
        isLoading = true;
        continue;
      }
      if (result instanceof Error || result === null) {
        failedRunIds.add(runId);
        continue;
      }
      byRun.set(runId, result.iterations ?? EMPTY_ITERATIONS);
    }
    const ordered = runIds.filter(
      (runId, index) => runIds.indexOf(runId) === index,
    );
    return {
      iterations: ordered.flatMap((runId) => byRun.get(runId) ?? []),
      byRun,
      isLoading,
      failedRunIds,
    };
    // `runIds` order only matters for the flattened list; its membership is
    // already in `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, results]);
}

/**
 * Every run a run page reads rows for: the run's launch (its sibling pairings)
 * and each "previous" the page can compare against — the launch before it
 * (combined hero deltas), the previous run of the same pairing, and the
 * explicit baseline the page was handed. A handful of runs, never the suite.
 */
export function runPageRunIds(
  selected: EvalSuiteRun,
  runs: readonly EvalSuiteRun[],
  previousRunId: string | null,
): string[] {
  const launch = launchRuns(selected, runs);
  const ids = new Set<string>([selected._id, ...launch.map((run) => run._id)]);
  for (const anchor of [previousRunId, null]) {
    for (const run of previousLaunchRuns(launch, runs, anchor) ?? []) {
      ids.add(run._id);
    }
  }
  const previousPairing = previousCompletedRunOf(selected, runs);
  if (previousPairing) ids.add(previousPairing._id);
  if (previousRunId) ids.add(previousRunId);
  return [...ids];
}
