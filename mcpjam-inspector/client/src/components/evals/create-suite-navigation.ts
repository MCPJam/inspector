import type { EvalRoute, SuiteSettingsTab } from "@/lib/eval-route-types";
import { buildEvaluatePath, navigateApp } from "@/lib/app-navigation";
import type { SuiteNavigation } from "./suite-iterations-view";

function applyEvaluatePath(
  route: EvalRoute,
  options?: { replace?: boolean }
) {
  navigateApp(buildEvaluatePath(route), { replace: options?.replace });
}

/**
 * The Suite settings route every navigation shares, so `/evaluate`, `/evals`
 * and CI all keep the tab and the case to return to.
 */
export function suiteEditRoute(
  suiteId: string,
  fromCaseChecks?: string,
  tab?: SuiteSettingsTab,
): EvalRoute {
  return {
    type: "suite-edit",
    suiteId,
    ...(fromCaseChecks ? { fromCaseChecks } : {}),
    ...(tab === "evaluators" ? { tab } : {}),
  };
}

/** Playground Explore opens the current Evaluate experience. */
export function navigatePlaygroundEvalsRoute(
  route: EvalRoute,
  options?: { replace?: boolean }
) {
  applyEvaluatePath(route, options);
}

/** Playground: same suite-overview / drill-down path shapes as CI. */
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
          ...(options?.checks ? { checks: true } : {}),
          ...(options?.iteration ? { iteration: options.iteration } : {}),
        },
        { replace: options?.replace }
      );
    },
    toSuiteEdit: (suiteId, fromCaseChecks, tab, options) =>
      applyEvaluatePath(
        suiteEditRoute(suiteId, fromCaseChecks, tab),
        options,
      ),
  };
}

/** CI/CD: preserves `fromCommit` when navigating within a commit drill-down. */
export function createCiSuiteNavigation(route: EvalRoute): SuiteNavigation {
  return {
    toSuiteOverview: (suiteId, view) =>
      applyEvaluatePath({
        type: "suite-overview",
        suiteId,
        view,
        ...(route.type === "suite-overview" && route.fromCommit
          ? { fromCommit: route.fromCommit }
          : {}),
      }),
    toRunDetail: (suiteId, runId, iteration, options) =>
      applyEvaluatePath({
        type: "run-detail",
        suiteId,
        runId,
        iteration,
        testCaseId: options?.testCaseId,
        insightsFocus: options?.insightsFocus,
        compareToRunId: options?.compareToRunId,
      }),
    toTestDetail: (suiteId, testId, iteration) =>
      applyEvaluatePath({
        type: "test-detail",
        suiteId,
        testId,
        iteration,
      }),
    toTestEdit: (suiteId, testId, options) =>
      applyEvaluatePath(
        {
          type: "test-edit",
          suiteId,
          testId,
          ...(options?.openCompare ? { openCompare: true } : {}),
          ...(options?.checks ? { checks: true } : {}),
          ...(options?.iteration ? { iteration: options.iteration } : {}),
        },
        { replace: options?.replace }
      ),
    toSuiteEdit: (suiteId, fromCaseChecks, tab, options) =>
      applyEvaluatePath(suiteEditRoute(suiteId, fromCaseChecks, tab), options),
  };
}
