import type {
  EvalRoute,
  EvaluateNavRoute,
  EvaluateNavRouteType,
} from "./eval-route-types";

/** Every navigation-rework route kind; a missing kind fails to compile. */
const EVALUATE_NAV_ROUTE_TYPES = {
  "evaluate-runs": true,
  "suite-settings": true,
  "case-new": true,
  "case-settings": true,
  "case-evaluators": true,
  "test-run": true,
  "test-run-edit": true,
  iteration: true,
} as const satisfies Record<EvaluateNavRouteType, true>;

export function isEvaluateNavRoute(
  route: EvalRoute,
): route is EvaluateNavRoute {
  return Object.hasOwn(EVALUATE_NAV_ROUTE_TYPES, route.type);
}

/**
 * Path for a navigation-rework route. These pages exist only under
 * `/evaluate`, so the caller passes that prefix whatever builder it came from.
 */
export function buildEvaluateNavRoutePath(
  prefix: string,
  route: EvaluateNavRoute,
): string {
  if (route.type === "evaluate-runs") return `${prefix}/runs`;
  const suite = `${prefix}/suite/${encodeURIComponent(route.suiteId)}`;
  switch (route.type) {
    case "suite-settings":
      return route.tab === "settings"
        ? `${suite}/settings`
        : `${suite}/settings/${route.tab}`;
    case "case-new":
      return `${suite}/settings/cases/new`;
    case "case-settings":
      return `${suite}/settings/cases/${encodeURIComponent(route.caseId)}`;
    case "case-evaluators":
      return `${suite}/settings/cases/${encodeURIComponent(
        route.caseId,
      )}/evaluators`;
  }
  const testRun = `${suite}/runs/${encodeURIComponent(
    route.runId,
  )}/cases/${encodeURIComponent(route.caseId)}`;
  switch (route.type) {
    case "test-run":
      return route.target
        ? `${testRun}?${new URLSearchParams({ target: route.target })}`
        : testRun;
    case "test-run-edit":
      return `${testRun}/edit`;
    case "iteration":
      return `${testRun}/iter/${encodeURIComponent(route.iterationId)}`;
  }
}
