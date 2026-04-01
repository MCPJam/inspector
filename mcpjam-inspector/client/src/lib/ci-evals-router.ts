/**
 * CI Evals Router - Hash-based routing for CI evals tab
 *
 * Route structure:
 * - #/ci-evals - Suite list view
 * - #/ci-evals/suite/:suiteId - Suite overview (runs + test cases)
 * - #/ci-evals/suite/:suiteId/runs/:runId - Run detail view
 * - #/ci-evals/suite/:suiteId/test/:testId - Test case detail view
 */

import { createEvalRouter } from "./eval-router-core";
import type { EvalRoute } from "./eval-route-types";

const router = createEvalRouter("/ci-evals");

/** @deprecated Prefer `EvalRoute`; alias kept for call sites. */
export type CiEvalsRoute = EvalRoute;

export const parseCiEvalsRoute = router.parse;

export function navigateToCiEvalsRoute(
  route: CiEvalsRoute,
  options?: { replace?: boolean },
) {
  router.navigate(route, options);
}

export const useCiEvalsRoute = router.useRoute;
