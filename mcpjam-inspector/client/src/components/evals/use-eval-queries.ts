import { useMemo } from "react";
import { useQuery } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import type {
  EvalSuiteOverviewEntry,
  SuiteDetailsQueryResponse,
  EvalSuiteRun,
} from "./types";
import { getIterationRecencyTimestamp } from "./helpers";

/**
 * Rows the Connector Bench owns, dropped before anything renders them.
 *
 * The FILTERING IS SERVER-SIDE and this is not a second implementation of it —
 * these queries are already scoped to exclude benchmark-origin suites and runs.
 * This is the client refusing to re-introduce them: every list below is
 * assembled from more than one read (an overview joined to its latest run, a
 * run list intersected with iterations), and each join is a place a filtered
 * row can walk back in through a projection that carried it for a different
 * reason.
 *
 * The reason it matters is not tidiness. A benchmark suite is an immutable
 * exam and its runs are evidence for a published score; showing them in
 * Evaluate offers a user the Edit, Re-run and Delete affordances that surface
 * carries, against rows where none of those are meaningful.
 *
 * The check is STRUCTURAL rather than typed against `EvalSuite["source"]`, and
 * that is the point: those unions describe what an Evaluate list may contain,
 * and after this filter `"benchmark"` is not one of the things it may contain.
 * Widening them to admit a value the lists must never hold would push a dead
 * `benchmark` case into every badge map and switch downstream of them.
 */
const BENCHMARK_SOURCE = "benchmark";

function isBenchmarkOwned(row: { source?: string | undefined }): boolean {
  return row.source === BENCHMARK_SOURCE;
}

/**
 * Hook for fetching eval data (overview, suite details, and runs)
 */
export function useEvalQueries({
  isAuthenticated,
  selectedSuiteId,
  deletingSuiteId,
  projectId,
  organizationId,
  isDirectGuest = false,
}: {
  isAuthenticated: boolean;
  selectedSuiteId: string | null;
  deletingSuiteId: string | null;
  projectId: string | null;
  organizationId: string | null;
  isDirectGuest?: boolean;
}) {
  const isUserReady = useDbUserReady();
  // Convex's `isAuthenticated` already covers hosted guests — they hold a
  // guest token via the unified auth provider — so a separate WorkOS `user`
  // check would wrongly skip queries for guests with a project.
  const hasActorAccess = isDirectGuest || (isAuthenticated && isUserReady);
  // Authenticated, but the `users` row is still bootstrapping: the queries are
  // skipped and an answer IS coming, so this window must report as loading.
  // Reporting it as settled-and-empty makes `EvalsTab`'s redirect read a
  // deep-linked suite as deleted and bounce it, and flashes the "no suites"
  // hero over a project that has suites.
  const isActorBootstrapping = !isDirectGuest && isAuthenticated && !isUserReady;

  const suiteOverviewArgs = useMemo(() => {
    if (projectId) {
      return { projectId } as const;
    }
    if (organizationId && !isDirectGuest) {
      return { organizationId } as const;
    }
    return {} as const;
  }, [isDirectGuest, organizationId, projectId]);

  const enableOverviewQuery = hasActorAccess;
  const suiteOverviewRaw = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    enableOverviewQuery ? (suiteOverviewArgs as any) : "skip"
  ) as EvalSuiteOverviewEntry[] | undefined;
  // `undefined` survives the filter rather than collapsing to `[]`: every
  // loading flag below reads it as "an answer is still coming", and an empty
  // array here would flash the "no suites" hero over a project that has some.
  const suiteOverview = useMemo(
    () => suiteOverviewRaw?.filter((entry) => !isBenchmarkOwned(entry.suite)),
    [suiteOverviewRaw]
  );

  const hasSelectedSuiteInPlay =
    !!selectedSuiteId && deletingSuiteId !== selectedSuiteId;
  const enableSuiteDetailsQuery = hasActorAccess && hasSelectedSuiteInPlay;
  const suiteDetails = useQuery(
    "testSuites:getAllTestCasesAndIterationsBySuite" as any,
    enableSuiteDetailsQuery ? ({ suiteId: selectedSuiteId } as any) : "skip"
  ) as SuiteDetailsQueryResponse | undefined;

  // Raised from 20 → 100 so a multi-host run group (up to ~5 hosts in
  // practice) is never truncated mid-group. The list consumer caps by
  // *groups* after grouping rather than capping raw rows, so groups
  // remain fully expandable even near the limit.
  const suiteRunsRaw = useQuery(
    "testSuites:listTestSuiteRuns" as any,
    enableSuiteDetailsQuery
      ? ({ suiteId: selectedSuiteId, limit: 100 } as any)
      : "skip"
  ) as EvalSuiteRun[] | undefined;
  const suiteRuns = useMemo(
    () => suiteRunsRaw?.filter((run) => !isBenchmarkOwned(run)),
    [suiteRunsRaw]
  );

  const isOverviewLoading =
    isActorBootstrapping || (enableOverviewQuery && suiteOverview === undefined);
  const isSuiteDetailsLoading =
    (isActorBootstrapping && hasSelectedSuiteInPlay) ||
    (enableSuiteDetailsQuery && suiteDetails === undefined);
  const isSuiteRunsLoading =
    (isActorBootstrapping && hasSelectedSuiteInPlay) ||
    (enableSuiteDetailsQuery && suiteRuns === undefined);

  const selectedSuiteEntry = useMemo(() => {
    if (!selectedSuiteId || !suiteOverview) return null;
    return (
      suiteOverview.find((entry) => entry.suite._id === selectedSuiteId) ?? null
    );
  }, [selectedSuiteId, suiteOverview]);

  const selectedSuite = selectedSuiteEntry?.suite ?? null;

  const sortedIterations = useMemo(() => {
    if (!suiteDetails) return [];
    return [...suiteDetails.iterations].sort(
      (a, b) =>
        getIterationRecencyTimestamp(b) - getIterationRecencyTimestamp(a),
    );
  }, [suiteDetails]);

  const runsForSelectedSuite = useMemo(
    () => (suiteRuns ? [...suiteRuns] : []),
    [suiteRuns]
  );

  const activeIterations = useMemo(() => {
    if (!suiteRuns || sortedIterations.length === 0) return sortedIterations;

    const runIds = new Set(suiteRuns.map((run) => run._id));

    return sortedIterations.filter(
      (iteration) => !iteration.suiteRunId || runIds.has(iteration.suiteRunId)
    );
  }, [sortedIterations, suiteRuns]);

  const sortedSuites = useMemo(() => {
    if (!suiteOverview) return [];
    return [...suiteOverview].sort((a, b) => {
      const aTime =
        a.suite.updatedAt ??
        a.latestRun?.completedAt ??
        a.latestRun?.createdAt ??
        a.suite._creationTime ??
        0;
      const bTime =
        b.suite.updatedAt ??
        b.latestRun?.completedAt ??
        b.latestRun?.createdAt ??
        b.suite._creationTime ??
        0;
      return bTime - aTime;
    });
  }, [suiteOverview]);

  return {
    suiteOverview,
    suiteDetails,
    suiteRuns,
    selectedSuiteEntry,
    selectedSuite,
    sortedIterations,
    runsForSelectedSuite,
    activeIterations,
    sortedSuites,
    isOverviewLoading,
    isSuiteDetailsLoading,
    isSuiteRunsLoading,
    enableOverviewQuery,
    enableSuiteDetailsQuery,
  };
}
