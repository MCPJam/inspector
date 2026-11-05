import { useMemo } from "react";
import { useQueries } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { EvalIteration } from "../../evals/types";

type IterationPage = {
  page: EvalIteration[];
  isDone: boolean;
  continueCursor: string;
};

/** One case's iterations within one suite run (backend `by_suiteRun_testCase`). */
const testRunIterationsQuery = makeFunctionReference<
  "query",
  {
    suiteRunId: string;
    testCaseId: string;
    paginationOpts: { numItems: number; cursor: string | null };
  },
  IterationPage
>("testRunIterations:listTestRunIterations");

/** The whole run's iterations: the fallback while a backend lacks the query above. */
const runIterationsQuery = makeFunctionReference<
  "query",
  {
    runId: string;
    paginationOpts: { numItems: number; cursor: string | null };
  },
  IterationPage
>("testSuites:listTestSuiteRunIterations");

/** Iterations one case can hold in one run before the page says it shows a part. */
export const TEST_RUN_ITERATION_PAGE = 200;
const RUN_FALLBACK_PAGE = 1000;

export type TestRunIterationsState = {
  /** `undefined` until every run's first page has arrived. */
  iterations: EvalIteration[] | undefined;
  /** True when some run held more of this case's iterations than one page. */
  truncated: boolean;
  /** True when no read succeeded for any run. */
  failed: boolean;
};

/**
 * One case's iterations across the runs of a launch, live while they run.
 *
 * Reads the paginated `listTestRunIterations` per run. A run whose read
 * fails (a backend deployed before the query) falls back to the run-wide
 * list, filtered here, so the page still opens.
 */
export function useTestRunIterations(
  runIds: readonly string[],
  testCaseId: string,
): TestRunIterationsState {
  const primary = useQueries(
    useMemo(
      () =>
        Object.fromEntries(
          runIds.map((suiteRunId) => [
            suiteRunId,
            {
              query: testRunIterationsQuery,
              args: {
                suiteRunId,
                testCaseId,
                paginationOpts: {
                  numItems: TEST_RUN_ITERATION_PAGE,
                  cursor: null,
                },
              },
            },
          ]),
        ),
      [runIds, testCaseId],
    ),
  ) as Record<string, IterationPage | Error | undefined>;

  const failedRunIds = runIds.filter((id) => primary[id] instanceof Error);
  const failedKey = failedRunIds.join(",");
  const fallback = useQueries(
    useMemo(
      () =>
        Object.fromEntries(
          (failedKey ? failedKey.split(",") : []).map((runId) => [
            runId,
            {
              query: runIterationsQuery,
              args: {
                runId,
                paginationOpts: { numItems: RUN_FALLBACK_PAGE, cursor: null },
              },
            },
          ]),
        ),
      [failedKey],
    ),
  ) as Record<string, IterationPage | Error | undefined>;

  return useMemo(() => {
    const iterations: EvalIteration[] = [];
    let truncated = false;
    let loading = false;
    let succeeded = 0;
    for (const runId of runIds) {
      const own = primary[runId];
      const page = own instanceof Error ? fallback[runId] : own;
      if (page === undefined) {
        loading = true;
        continue;
      }
      if (page instanceof Error) continue;
      succeeded += 1;
      if (!page.isDone) truncated = true;
      iterations.push(
        ...(own instanceof Error
          ? page.page.filter((row) => row.testCaseId === testCaseId)
          : page.page),
      );
    }
    return {
      iterations: loading ? undefined : iterations,
      truncated,
      failed: !loading && runIds.length > 0 && succeeded === 0,
    };
  }, [runIds, primary, fallback, testCaseId]);
}
