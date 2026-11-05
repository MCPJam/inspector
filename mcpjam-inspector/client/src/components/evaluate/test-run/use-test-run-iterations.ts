import { useEffect } from "react";
import { usePaginatedQuery } from "convex/react";
import {
  makeFunctionReference,
  type PaginationOptions,
  type PaginationResult,
} from "convex/server";
import type { EvalIteration } from "../../evals/types";

/** One case's iterations within one run (backend `testRunIterations.ts`, E5). */
const testRunIterationsQuery = makeFunctionReference<
  "query",
  { suiteRunId: string; testCaseId: string; paginationOpts: PaginationOptions },
  PaginationResult<EvalIteration>
>("testRunIterations:listTestRunIterations");

const PAGE_SIZE = 100;

/**
 * Every iteration of a test run. Pages are followed to the end so the counts
 * and percentiles on the page describe the whole test run, never page one.
 */
export function useTestRunIterations(suiteRunId: string, testCaseId: string) {
  const { results, status, loadMore } = usePaginatedQuery(
    testRunIterationsQuery,
    { suiteRunId, testCaseId },
    { initialNumItems: PAGE_SIZE },
  );
  useEffect(() => {
    if (status === "CanLoadMore") loadMore(PAGE_SIZE);
  }, [status, loadMore]);
  return {
    iterations: results,
    isLoading: status === "LoadingFirstPage",
    isComplete: status === "Exhausted",
  };
}
