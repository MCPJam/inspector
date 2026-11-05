import { useMemo } from "react";
import { useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { useEvalRunDecisionDetail } from "@/hooks/use-eval-run-decision-summary";
import {
  evalRunDecisionRevision,
  isTerminalEvalRunStatus,
} from "@/lib/evals/eval-decision-summary-store";
import type { EvalCase, EvalSuite } from "../../evals/types";
import { useSelectedRun } from "../../evals/use-selected-run";
import { buildRunResultsMatrix } from "../run-results-matrix-model";
import { caseTargets } from "./test-run-model";
import { useTestRunIterations } from "./use-test-run-iterations";

const suiteQuery = makeFunctionReference<
  "query",
  { suiteId: string },
  EvalSuite | null
>("testSuites:getTestSuite");
const suiteCasesQuery = makeFunctionReference<
  "query",
  { suiteId: string },
  EvalCase[]
>("testSuites:listTestCases");

const NO_HOST_NAMES = new Map<string, string | null>();

/** Everything the Test run and Iteration pages read for one case in one run. */
export function useTestRunData(
  route: { suiteId: string; runId: string; caseId: string },
  options: { loadCase?: boolean } = {},
) {
  const { suiteId, runId, caseId } = route;
  const selected = useSelectedRun(suiteId, runId);
  const run = selected.run;
  const suite = useQuery(suiteQuery, { suiteId });
  const cases = useQuery(
    suiteCasesQuery,
    options.loadCase ? { suiteId } : "skip",
  );
  const { iterations, isLoading, isComplete } = useTestRunIterations(
    runId,
    caseId,
  );
  const decision = useEvalRunDecisionDetail({
    projectId: run?.projectId ?? null,
    runId: run?._id ?? null,
    enabled: Boolean(run) && isTerminalEvalRunStatus(run?.status),
    ...(run ? { revision: evalRunDecisionRevision(run) } : {}),
  });
  const matrix = useMemo(
    () =>
      run
        ? buildRunResultsMatrix({
            run,
            runs: [],
            iterations,
            hostNamesById: NO_HOST_NAMES,
          })
        : null,
    [run, iterations],
  );
  const testCase =
    cases === undefined
      ? undefined
      : (cases.find((item) => item._id === caseId) ?? null);
  return {
    run,
    isRunLoading: selected.isLoading,
    isRunUnavailable: selected.isUnavailable,
    suite: suite ?? null,
    testCase,
    iterations,
    isLoading,
    isComplete,
    targets: matrix ? caseTargets(matrix, caseId) : [],
    caseTitle:
      matrix?.rows.find((row) => row.key === caseId)?.title ??
      iterations[0]?.testCaseSnapshot?.title,
    diagnostics: decision.diagnostics,
  };
}
