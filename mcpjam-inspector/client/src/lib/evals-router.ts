/**
 * Evals Router - Hash-based routing for evals tab
 *
 * Route structure:
 * - #/evals - Suite list view
 * - #/evals/create - Create new suite
 * - #/evals/suite/:suiteId - Suite overview (runs + test cases)
 * - #/evals/suite/:suiteId/runs/:runId - Run detail view
 * - #/evals/suite/:suiteId/test/:testId - Test case detail view
 * - #/evals/suite/:suiteId/edit - Edit suite configuration
 */

import { createEvalRouter } from "./eval-router-core";
import type { EvalRoute } from "./eval-route-types";

const router = createEvalRouter("/evals");

/** @deprecated Prefer `EvalRoute`; alias kept for call sites. */
export type EvalsRoute = EvalRoute;

export const parseEvalsRoute = router.parse;
export const navigateToEvalsRoute = (
  route: EvalsRoute,
  options?: { replace?: boolean },
) => router.navigate(route, options);
export const buildEvalsHash = router.build;
export const useEvalsRoute = router.useRoute;
