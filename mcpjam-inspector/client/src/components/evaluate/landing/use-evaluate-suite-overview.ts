import { useConvexAuth } from "convex/react";
import { useIsDirectGuest } from "@/hooks/use-is-direct-guest";
import { useEvalQueries } from "../../evals/use-eval-queries";
import type { EvalSuiteOverviewEntry } from "../../evals/types";

/**
 * The project's suites from `getTestSuitesOverview`, read with the same
 * arguments as today's Evaluate tab so both share one subscription.
 */
export function useEvaluateSuiteOverview(projectId: string | null): {
  suites: EvalSuiteOverviewEntry[];
  isLoading: boolean;
} {
  const { isAuthenticated } = useConvexAuth();
  const isDirectGuest = useIsDirectGuest({ projectId });
  const { sortedSuites, isOverviewLoading } = useEvalQueries({
    isAuthenticated: isAuthenticated && Boolean(projectId),
    selectedSuiteId: null,
    deletingSuiteId: null,
    projectId,
    organizationId: null,
    isDirectGuest,
  });
  return { suites: sortedSuites, isLoading: isOverviewLoading };
}
