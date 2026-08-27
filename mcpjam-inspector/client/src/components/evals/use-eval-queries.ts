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
  const suiteOverview = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    enableOverviewQuery ? (suiteOverviewArgs as any) : "skip"
  ) as EvalSuiteOverviewEntry[] | undefined;

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
  const suiteRuns = useQuery(
    "testSuites:listTestSuiteRuns" as any,
    enableSuiteDetailsQuery
      ? ({ suiteId: selectedSuiteId, limit: 100 } as any)
      : "skip"
  ) as EvalSuiteRun[] | undefined;

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
