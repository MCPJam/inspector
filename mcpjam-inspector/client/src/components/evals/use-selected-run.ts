import { useMemo } from "react";
import { useQueries } from "convex/react";
import { makeFunctionReference } from "convex/server";
import type { EvalSuiteRun } from "./types";

const selectedRunQuery = makeFunctionReference<
  "query",
  { runId: string },
  EvalSuiteRun | null
>("testSuites:getTestSuiteRun");

/** Details are independent of history pagination, including direct links to old runs. */
export function useSelectedRun(suiteId: string, runId: string | null) {
  const queries = useMemo(() => {
    const requests: Parameters<typeof useQueries>[0] = {};
    if (runId)
      requests.selectedRun = { query: selectedRunQuery, args: { runId } };
    return requests;
  }, [runId]);
  const result = useQueries(queries).selectedRun as
    | EvalSuiteRun
    | null
    | Error
    | undefined;
  return {
    run:
      result && !(result instanceof Error) && result.suiteId === suiteId
        ? result
        : null,
    isLoading: Boolean(runId) && result === undefined,
    isUnavailable:
      Boolean(runId) &&
      result !== undefined &&
      (!result || result instanceof Error || result.suiteId !== suiteId),
  };
}
