import type { EvalRoute } from "@/lib/eval-route-types";
import {
  buildCiEvalsPath,
  buildEvalsPath,
  navigateApp,
} from "@/lib/app-navigation";
import type { SuiteNavigation } from "./suite-iterations-view";

function applyPlaygroundEvalsPath(
  route: EvalRoute,
  options?: { replace?: boolean }
) {
  navigateApp(buildEvalsPath(route), { replace: options?.replace });
}

function applyCiEvalsPath(route: EvalRoute, options?: { replace?: boolean }) {
  navigateApp(buildCiEvalsPath(route), { replace: options?.replace });
}

/** Playground Explore: same path shape as `buildEvalsPath`. */
export function navigatePlaygroundEvalsRoute(
  route: EvalRoute,
  options?: { replace?: boolean }
) {
  applyPlaygroundEvalsPath(route, options);
}

/** Playground: same suite-overview / drill-down path shapes as CI. */
export function createPlaygroundSuiteNavigation(): SuiteNavigation {
  return {
    toSuiteOverview: (suiteId, view) => {
      applyPlaygroundEvalsPath({ type: "suite-overview", suiteId, view });
    },
    toRunDetail: (suiteId, runId, iteration, options) => {
      applyPlaygroundEvalsPath(
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
      applyPlaygroundEvalsPath({
        type: "test-detail",
        suiteId,
        testId,
        iteration,
      });
    },
    toTestEdit: (suiteId, testId, options) => {
      applyPlaygroundEvalsPath(
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
      applyPlaygroundEvalsPath({ type: "suite-edit", suiteId });
    },
  };
}

/** CI/CD: preserves `fromCommit` when navigating within a commit drill-down. */
export function createCiSuiteNavigation(route: EvalRoute): SuiteNavigation {
  return {
    toSuiteOverview: (suiteId, view) =>
      applyCiEvalsPath({
        type: "suite-overview",
        suiteId,
        view,
        ...(route.type === "suite-overview" && route.fromCommit
          ? { fromCommit: route.fromCommit }
          : {}),
      }),
    toRunDetail: (suiteId, runId, iteration, options) =>
      applyCiEvalsPath({
        type: "run-detail",
        suiteId,
        runId,
        iteration,
        testCaseId: options?.testCaseId,
        insightsFocus: options?.insightsFocus,
        compareToRunId: options?.compareToRunId,
      }),
    toTestDetail: (suiteId, testId, iteration) =>
      applyCiEvalsPath({
        type: "test-detail",
        suiteId,
        testId,
        iteration,
      }),
    toTestEdit: (suiteId, testId, options) =>
      applyCiEvalsPath(
        {
          type: "test-edit",
          suiteId,
          testId,
          ...(options?.openCompare ? { openCompare: true } : {}),
          ...(options?.iteration ? { iteration: options.iteration } : {}),
        },
        { replace: options?.replace }
      ),
    toSuiteEdit: (suiteId) => applyCiEvalsPath({ type: "suite-edit", suiteId }),
  };
}
