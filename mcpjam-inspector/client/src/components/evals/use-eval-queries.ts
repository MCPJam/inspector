import { useMemo } from "react";
import { useQuery } from "convex/react";
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
  user,
  selectedSuiteId,
  deletingSuiteId,
  workspaceId,
  organizationId,
  isDirectGuest = false,
}: {
  isAuthenticated: boolean;
  user: any;
  selectedSuiteId: string | null;
  deletingSuiteId: string | null;
  workspaceId: string | null;
  organizationId: string | null;
  isDirectGuest?: boolean;
}) {
  const hasActorAccess = isDirectGuest || (isAuthenticated && !!user);

  const suiteOverviewArgs = useMemo(() => {
    if (workspaceId) {
      return { workspaceId } as const;
    }
    if (organizationId && !isDirectGuest) {
      return { organizationId } as const;
    }
    return {} as const;
  }, [isDirectGuest, organizationId, workspaceId]);

  const enableOverviewQuery = hasActorAccess;
  const suiteOverview = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    enableOverviewQuery ? (suiteOverviewArgs as any) : "skip"
  ) as EvalSuiteOverviewEntry[] | undefined;

  const enableSuiteDetailsQuery =
    hasActorAccess && !!selectedSuiteId && deletingSuiteId !== selectedSuiteId;
  const suiteDetails = useQuery(
    "testSuites:getAllTestCasesAndIterationsBySuite" as any,
    enableSuiteDetailsQuery ? ({ suiteId: selectedSuiteId } as any) : "skip"
  ) as SuiteDetailsQueryResponse | undefined;

  const suiteRuns = useQuery(
    "testSuites:listTestSuiteRuns" as any,
    enableSuiteDetailsQuery
      ? ({ suiteId: selectedSuiteId, limit: 20 } as any)
      : "skip"
  ) as EvalSuiteRun[] | undefined;

  const isOverviewLoading = enableOverviewQuery && suiteOverview === undefined;
  const isSuiteDetailsLoading =
    enableSuiteDetailsQuery && suiteDetails === undefined;
  const isSuiteRunsLoading = enableSuiteDetailsQuery && suiteRuns === undefined;

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
