/**
 * Navigation for the flag-gated Evaluate (New) tab.
 *
 * A copy of `evals/create-suite-navigation.ts`'s playground half, bound to
 * `/evaluate` instead of `/evals`. Deliberately duplicated rather than
 * parameterized: the two tabs ship side by side only until the new one
 * replaces the old, and a shared prefix argument would have to be threaded
 * through every caller of `navigatePlaygroundEvalsRoute` in the v1 tab —
 * exactly the shared-surface edit this tab exists to avoid.
 *
 * Runs mode has no counterpart here: the new landing's Runs view is in-page
 * state over `ProjectRunsTable`, and the commit-keyed CI lens stays on
 * `/evals/runs` under the original tab.
 */
import type { EvalRoute } from "@/lib/eval-route-types";
import { buildEvaluatePath, navigateApp } from "@/lib/app-navigation";
import type { SuiteNavigation } from "../evals/suite-iterations-view";

function applyEvaluatePath(route: EvalRoute, options?: { replace?: boolean }) {
  navigateApp(buildEvaluatePath(route), { replace: options?.replace });
}

export function navigatePlaygroundEvalsRoute(
  route: EvalRoute,
  options?: { replace?: boolean }
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
        },
        { replace: options?.replace }
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
          ...(options?.iteration ? { iteration: options.iteration } : {}),
        },
        { replace: options?.replace }
      );
    },
    toSuiteEdit: (suiteId) => {
      applyEvaluatePath({ type: "suite-edit", suiteId });
    },
  };
}
