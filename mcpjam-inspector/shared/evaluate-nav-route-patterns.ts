/**
 * Paths of the Evaluate navigation rework (`EvaluateNavRoute` in
 * `client/src/lib/eval-route-types.ts`). The app route table, the router and
 * the `evaluate` surface all register this one list, so they cannot drift.
 */
export const EVALUATE_NAV_ROUTE_PATTERNS = [
  "evaluate/runs",
  "evaluate/suite/:suiteId/settings",
  "evaluate/suite/:suiteId/settings/cases",
  "evaluate/suite/:suiteId/settings/evaluators",
  "evaluate/suite/:suiteId/settings/cases/new",
  "evaluate/suite/:suiteId/settings/cases/:caseId",
  "evaluate/suite/:suiteId/settings/cases/:caseId/evaluators",
  "evaluate/suite/:suiteId/runs/:runId/cases/:caseId",
  "evaluate/suite/:suiteId/runs/:runId/cases/:caseId/edit",
  "evaluate/suite/:suiteId/runs/:runId/cases/:caseId/iter/:iterationId",
] as const;
