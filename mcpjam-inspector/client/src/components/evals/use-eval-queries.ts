import { useMemo } from "react";
import { useQuery } from "convex/react";
import { useShallow } from "zustand/react/shallow";
import { useGuestEvalsStore } from "@/stores/guest-evals-store";
import type {
  EvalSuite,
  EvalSuiteOverviewEntry,
  SuiteDetailsQueryResponse,
  EvalSuiteRun,
} from "./types";

const EMPTY_GUEST_SUITES: EvalSuite[] = [];

function buildGuestOverviewEntry(suite: EvalSuite): EvalSuiteOverviewEntry {
  return {
    suite,
    latestRun: null,
    recentRuns: [],
    passRateTrend: [],
    totals: { passed: 0, failed: 0, runs: 0 },
  };
}

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
  // ── Guest branch: all data sourced from the local store ────────────────
  const guestSuites = useGuestEvalsStore(
    useShallow((state) => {
      if (!isDirectGuest) return EMPTY_GUEST_SUITES;
      return Object.values(state.serverBuckets).map((bucket) => bucket.suite);
    }),
  );
  const guestSelectedBucket = useGuestEvalsStore((state) => {
    if (!isDirectGuest || !selectedSuiteId) return null;
    return (
      Object.values(state.serverBuckets).find(
        (bucket) => bucket.suite._id === selectedSuiteId,
      ) ?? null
    );
  });

  const guestOverview = useMemo<EvalSuiteOverviewEntry[]>(() => {
    if (!isDirectGuest) return [];
    return guestSuites.map(buildGuestOverviewEntry);
  }, [guestSuites, isDirectGuest]);

  const guestSuiteDetails = useMemo<SuiteDetailsQueryResponse | undefined>(
    () => {
      if (!isDirectGuest || !guestSelectedBucket) return undefined;
      return {
        testCases: guestSelectedBucket.testCases,
        iterations: guestSelectedBucket.iterations,
      };
    },
    [guestSelectedBucket, isDirectGuest],
  );

  // Overview query - list all suites (skipped for guests)
  const enableOverviewQuery = !isDirectGuest && isAuthenticated && !!user;
  const suiteOverviewFromConvex = useQuery(
    "testSuites:getTestSuitesOverview" as any,
    enableOverviewQuery
      ? ({
          ...(workspaceId ? { workspaceId } : {}),
          ...(!workspaceId && organizationId ? { organizationId } : {}),
        } as any)
      : "skip",
  ) as EvalSuiteOverviewEntry[] | undefined;

  const suiteOverview = isDirectGuest
    ? guestOverview
    : suiteOverviewFromConvex;

  // Suite details query - full suite data for selected suite
  const enableSuiteDetailsQuery =
    !isDirectGuest &&
    isAuthenticated &&
    !!user &&
    !!selectedSuiteId &&
    deletingSuiteId !== selectedSuiteId;
  const suiteDetailsFromConvex = useQuery(
    "testSuites:getAllTestCasesAndIterationsBySuite" as any,
    enableSuiteDetailsQuery ? ({ suiteId: selectedSuiteId } as any) : "skip",
  ) as SuiteDetailsQueryResponse | undefined;

  const suiteDetails = isDirectGuest
    ? guestSuiteDetails
    : suiteDetailsFromConvex;

  // Suite runs query - runs for selected suite (always empty for guests)
  const suiteRunsFromConvex = useQuery(
    "testSuites:listTestSuiteRuns" as any,
    enableSuiteDetailsQuery
      ? ({ suiteId: selectedSuiteId, limit: 20 } as any)
      : "skip",
  ) as EvalSuiteRun[] | undefined;

  const EMPTY_RUNS: EvalSuiteRun[] = useMemo(() => [], []);
  const suiteRuns = isDirectGuest ? EMPTY_RUNS : suiteRunsFromConvex;

  // Loading states
  const isOverviewLoading = enableOverviewQuery && suiteOverview === undefined;
  const isSuiteDetailsLoading =
    enableSuiteDetailsQuery && suiteDetails === undefined;
  const isSuiteRunsLoading = enableSuiteDetailsQuery && suiteRuns === undefined;

  // Selected suite entry from overview
  const guestSelectedSuiteEntry = useMemo(() => {
    if (!isDirectGuest || !guestSelectedBucket) return null;
    return buildGuestOverviewEntry(guestSelectedBucket.suite);
  }, [guestSelectedBucket, isDirectGuest]);

  const selectedSuiteEntry = useMemo(() => {
    if (isDirectGuest) return guestSelectedSuiteEntry;
    if (!selectedSuiteId || !suiteOverview) return null;
    return (
      suiteOverview.find((entry) => entry.suite._id === selectedSuiteId) ?? null
    );
  }, [guestSelectedSuiteEntry, isDirectGuest, selectedSuiteId, suiteOverview]);

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

  const activeIterations = useMemo(() => {
    if (!suiteRuns || sortedIterations.length === 0) return sortedIterations;

    const runIds = new Set(suiteRuns.map((run) => run._id));

    return sortedIterations.filter(
      (iteration) => !iteration.suiteRunId || runIds.has(iteration.suiteRunId),
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
