/** Navigation for public Evaluate, including its project run table. */
import type { EvalRoute } from "@/lib/eval-route-types";
import { buildEvaluatePath, navigateApp } from "@/lib/app-navigation";
import type { SuiteNavigation } from "../evals/suite-iterations-view";

function applyEvaluatePath(route: EvalRoute, options?: { replace?: boolean }) {
  navigateApp(buildEvaluatePath(route), { replace: options?.replace });
}

export function navigatePlaygroundEvalsRoute(
  route: EvalRoute,
  options?: { replace?: boolean },
) {
  applyEvaluatePath(route, options);
}

export function createPlaygroundSuiteNavigation(): SuiteNavigation {
  return {
    toSuiteOverview: (suiteId, view) => {
      applyEvaluatePath({ type: "suite-overview", suiteId, view });
    },
    toRunDetail: (suiteId, runId, iteration, options) => {
      applyEvaluatePath(
        {
          type: "run-detail",
          suiteId,
          runId,
          iteration,
          testCaseId: options?.testCaseId,
          insightsFocus: options?.insightsFocus,
          compareToRunId: options?.compareToRunId,
          comparison: options?.comparison,
        },
        { replace: options?.replace },
      );
    },
    toTestDetail: (suiteId, testId, iteration) => {
      applyEvaluatePath({
        type: "test-detail",
        suiteId,
        testId,
        iteration,
      });
    },
    toTestEdit: (suiteId, testId, options) => {
      applyEvaluatePath(
        {
          type: "test-edit",
          suiteId,
          testId,
          ...(options?.openCompare ? { openCompare: true } : {}),
          ...(options?.checks ? { checks: true } : {}),
          ...(options?.iteration ? { iteration: options.iteration } : {}),
          ...(options?.fromEvalServer
            ? { fromEvalServer: options.fromEvalServer }
            : {}),
        },
        { replace: options?.replace },
      );
    },
    toSuiteEdit: (suiteId, fromCaseChecks) => {
      applyEvaluatePath({
        type: "suite-edit",
        suiteId,
        ...(fromCaseChecks ? { fromCaseChecks } : {}),
      });
    },
  };
}
