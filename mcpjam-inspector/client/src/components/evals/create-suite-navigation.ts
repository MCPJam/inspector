import type { EvalRoute } from "@/lib/eval-route-types";
import { navigateToCiEvalsRoute } from "@/lib/ci-evals-router";
import { buildEvalsHash } from "@/lib/evals-router";
import { withTestingSurface } from "@/lib/testing-surface";
import type { SuiteNavigation } from "./suite-iterations-view";

function applyPlaygroundEvalsHash(
  route: Parameters<typeof buildEvalsHash>[0],
  options?: { replace?: boolean },
) {
  const hash = withTestingSurface(buildEvalsHash(route));
  if (options?.replace && typeof window !== "undefined") {
    history.replaceState({}, "", `/${hash}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = hash;
}

/** Playground Explore: same hash shape as `navigateToEvalsRoute` but wrapped with `withTestingSurface`. */
export function navigatePlaygroundEvalsRoute(
  route: EvalRoute,
  options?: { replace?: boolean },
) {
  applyPlaygroundEvalsHash(route, options);
}

/** Playground: same suite-overview / drill-down hash shapes as CI, wrapped with `withTestingSurface`. */
export function createPlaygroundSuiteNavigation(): SuiteNavigation {
  return {
    toSuiteOverview: (suiteId, view) => {
      applyPlaygroundEvalsHash({ type: "suite-overview", suiteId, view });
    },
    toRunDetail: (suiteId, runId, iteration, options) => {
      applyPlaygroundEvalsHash(
        {
          type: "run-detail",
          suiteId,
          runId,
          iteration,
          insightsFocus: options?.insightsFocus,
        },
        { replace: options?.replace },
      );
    },
    toTestDetail: (suiteId, testId, iteration) => {
      applyPlaygroundEvalsHash({
        type: "test-detail",
        suiteId,
        testId,
        iteration,
      });
    },
    toTestEdit: (suiteId, testId, options) => {
      applyPlaygroundEvalsHash(
        {
          type: "test-edit",
          suiteId,
          testId,
          ...(options?.openCompare ? { openCompare: true } : {}),
        },
        { replace: options?.replace },
      );
    },
    toSuiteEdit: (suiteId) => {
      applyPlaygroundEvalsHash({ type: "suite-edit", suiteId });
    },
  };
}

/** CI/CD: preserves `fromCommit` when navigating within a commit drill-down. */
export function createCiSuiteNavigation(route: EvalRoute): SuiteNavigation {
  return {
    toSuiteOverview: (suiteId, view) =>
      navigateToCiEvalsRoute({
        type: "suite-overview",
        suiteId,
        view,
        ...(route.type === "suite-overview" && route.fromCommit
          ? { fromCommit: route.fromCommit }
          : {}),
      }),
    toRunDetail: (suiteId, runId, iteration, options) =>
      navigateToCiEvalsRoute({
        type: "run-detail",
        suiteId,
        runId,
        iteration,
        insightsFocus: options?.insightsFocus,
      }),
    toTestDetail: (suiteId, testId, iteration) =>
      navigateToCiEvalsRoute({
        type: "test-detail",
        suiteId,
        testId,
        iteration,
      }),
    toTestEdit: (suiteId, testId, options) =>
      navigateToCiEvalsRoute(
        {
          type: "test-edit",
          suiteId,
          testId,
          ...(options?.openCompare ? { openCompare: true } : {}),
        },
        { replace: options?.replace },
      ),
    toSuiteEdit: (suiteId) =>
      navigateToCiEvalsRoute({ type: "suite-edit", suiteId }),
  };
}
