/**
 * Where the case editor's pages lead. The breadcrumb comes from the route
 * alone (`buildEvaluateNavCrumbs`); these add Back and the links between the
 * editor and its evaluators page.
 */

import type { EvalRoute, EvaluateNavRoute } from "@/lib/eval-route-types";

/** The route kinds the case editor serves. */
export type CaseEditorRoute = Extract<
  EvaluateNavRoute,
  { type: "case-settings" | "case-new" | "test-run-edit" }
>;
export type CaseEvaluatorsRoute = Extract<
  EvaluateNavRoute,
  { type: "case-evaluators" }
>;

/** Back leads one level up the page's own trail (D13 for `test-run-edit`). */
export function caseBackTarget(route: CaseEditorRoute | CaseEvaluatorsRoute): {
  label: string;
  route: EvalRoute;
} {
  switch (route.type) {
    case "case-settings":
    case "case-new":
      return {
        label: "Back to suite settings",
        route: { type: "suite-settings", suiteId: route.suiteId, tab: "cases" },
      };
    case "test-run-edit":
      return {
        label: "Back to test run",
        route: {
          type: "test-run",
          suiteId: route.suiteId,
          runId: route.runId,
          caseId: route.caseId,
        },
      };
    case "case-evaluators":
      return {
        label: "Back to test case",
        route: {
          type: "case-settings",
          suiteId: route.suiteId,
          caseId: route.caseId,
        },
      };
  }
}

/** The case's id on a route, or `null` for a case not saved yet. */
export function caseIdOf(route: CaseEditorRoute): string | null {
  return route.type === "case-new" ? null : route.caseId;
}

/**
 * Where a case editor goes after its first save. A new case becomes its own
 * page; an existing one stays where it is.
 */
export function routeAfterSave(
  route: CaseEditorRoute,
  savedCaseId: string,
): EvalRoute | null {
  return route.type === "case-new"
    ? { type: "case-settings", suiteId: route.suiteId, caseId: savedCaseId }
    : null;
}
