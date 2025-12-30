import { useMemo } from "react";
import { useQuery } from "convex/react";
import type {
  EvalSuiteOverviewEntry,
  SuiteDetailsQueryResponse,
  EvalSuiteRun,
} from "./types";

/**
 * Hook for fetching eval data (overview, suite details, and runs)
 */
export function useEvalQueries({
  isAuthenticated,
  user,
  selectedSuiteId,
  deletingSuiteId,
}: {
  isAuthenticated: boolean;
  user: any;
  selectedSuiteId: string | null;
  deletingSuiteId: string | null;
}) {
  // Overview query - list all suites
  const enableOverviewQuery = isAuthenticated && !!user;
  const suiteOverview = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    enableOverviewQuery ? ({} as any) : "skip",
  ) as EvalSuiteOverviewEntry[] | undefined;

  // Suite details query - full suite data for selected suite
  const enableSuiteDetailsQuery =
    isAuthenticated &&
    !!user &&
    !!selectedSuiteId &&
    deletingSuiteId !== selectedSuiteId;
  const suiteDetails = useQuery(
    "testSuites:getAllTestCasesAndIterationsBySuite" as any,
    enableSuiteDetailsQuery ? ({ suiteId: selectedSuiteId } as any) : "skip",
  ) as SuiteDetailsQueryResponse | undefined;

  // Suite runs query - runs for selected suite
  const suiteRuns = useQuery(
    "testSuites:listTestSuiteRuns" as any,
    enableSuiteDetailsQuery
      ? ({ suiteId: selectedSuiteId, limit: 20 } as any)
      : "skip",
  ) as EvalSuiteRun[] | undefined;

  // Loading states
  const isOverviewLoading = suiteOverview === undefined;
  const isSuiteDetailsLoading =
    enableSuiteDetailsQuery && suiteDetails === undefined;
  const isSuiteRunsLoading = enableSuiteDetailsQuery && suiteRuns === undefined;

  // Selected suite entry from overview
  const selectedSuiteEntry = useMemo(() => {
    if (!selectedSuiteId || !suiteOverview) return null;
    return (
      suiteOverview.find((entry) => entry.suite._id === selectedSuiteId) ?? null
    );
  }, [selectedSuiteId, suiteOverview]);

  const selectedSuite = selectedSuiteEntry?.suite ?? null;

  // Sorted iterations by date
  const sortedIterations = useMemo(() => {
    if (!suiteDetails) return [];
    return [...suiteDetails.iterations].sort(
      (a, b) => (b.startedAt || b.createdAt) - (a.startedAt || a.createdAt),
    );
  }, [suiteDetails]);

  // Runs array
  const runsForSelectedSuite = useMemo(
    () => (suiteRuns ? [...suiteRuns] : []),
    [suiteRuns],
  );

  // Filter iterations to only include those from active runs
  const activeIterations = useMemo(() => {
    if (!suiteRuns || sortedIterations.length === 0) return sortedIterations;

    const activeRunIds = new Set(
      suiteRuns.filter((run) => run.isActive !== false).map((run) => run._id),
    );

    return sortedIterations.filter(
      (iteration) =>
        !iteration.suiteRunId || activeRunIds.has(iteration.suiteRunId),
    );
  }, [sortedIterations, suiteRuns]);

  // Sorted suites for sidebar
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
    // Raw data
    suiteOverview,
    suiteDetails,
    suiteRuns,
    // Computed data
    selectedSuiteEntry,
    selectedSuite,
    sortedIterations,
    runsForSelectedSuite,
    activeIterations,
    sortedSuites,
    // Loading states
    isOverviewLoading,
    isSuiteDetailsLoading,
    isSuiteRunsLoading,
    // Query enabled flags
    enableOverviewQuery,
    enableSuiteDetailsQuery,
  };
}
