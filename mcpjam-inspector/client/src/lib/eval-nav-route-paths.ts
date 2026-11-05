import type {
  EvalNavRoute,
  EvalNavRouteKind,
  SuiteSettingsRouteTab,
} from "./eval-route-types";

/**
 * Router patterns for Evaluate's page-per-layer routes, relative to the
 * project. `app-routes.ts` and `router.tsx` both register this one list, so
 * the two tables cannot disagree about it.
 */
export const EVALUATE_NAV_ROUTE_PATHS = [
  "evaluate/runs",
  "evaluate/suite/:suiteId/settings",
  "evaluate/suite/:suiteId/settings/cases",
  "evaluate/suite/:suiteId/settings/evaluators",
  "evaluate/suite/:suiteId/settings/cases/new",
  "evaluate/suite/:suiteId/settings/cases/:testCaseId",
  "evaluate/suite/:suiteId/settings/cases/:testCaseId/evaluators",
  "evaluate/suite/:suiteId/runs/:runId/cases/:testCaseId",
  "evaluate/suite/:suiteId/runs/:runId/cases/:testCaseId/iter/:iterationId",
  "evaluate/suite/:suiteId/runs/:runId/cases/:testCaseId/edit",
] as const;

const EVAL_NAV_ROUTE_KINDS: ReadonlySet<string> = new Set<EvalNavRouteKind>([
  "evaluate-runs",
  "suite-settings",
  "case-new",
  "case-settings",
  "case-evaluators",
  "test-run",
  "iteration",
  "test-run-edit",
]);

export function isEvalNavRoute(route: { type: string }): route is EvalNavRoute {
  return EVAL_NAV_ROUTE_KINDS.has(route.type);
}

/** `runs`, the one Evaluate route outside a suite. */
export function parseEvaluateRootNavRoute(
  tail: readonly string[],
): EvalNavRoute | null {
  return tail.length === 1 && tail[0] === "runs"
    ? { type: "evaluate-runs" }
    : null;
}

/**
 * The segments after `suite/:suite`, already decoded. Null when they are not
 * a page-per-layer route, so the caller's older shapes still apply.
 */
export function parseSuiteNavRoute(
  suiteId: string,
  rest: readonly string[],
  params: URLSearchParams,
): EvalNavRoute | null {
  if (rest[0] === "settings") return parseSettingsRoute(suiteId, rest);
  const [runs, runId, cases, testCaseId, leaf, iterationId] = rest;
  if (runs !== "runs" || !runId || cases !== "cases" || !testCaseId) {
    return null;
  }
  if (rest.length === 4) {
    const target = params.get("target");
    return {
      type: "test-run",
      suiteId,
      runId,
      testCaseId,
      ...(target ? { target } : {}),
    };
  }
  if (rest.length === 5 && leaf === "edit") {
    const step = params.get("step");
    return {
      type: "test-run-edit",
      suiteId,
      runId,
      testCaseId,
      ...(step ? { step } : {}),
    };
  }
  if (rest.length === 6 && leaf === "iter" && iterationId) {
    return { type: "iteration", suiteId, runId, testCaseId, iterationId };
  }
  return null;
}

function parseSettingsRoute(
  suiteId: string,
  rest: readonly string[],
): EvalNavRoute | null {
  const [, section, testCaseId, leaf] = rest;
  if (rest.length === 1)
    return { type: "suite-settings", suiteId, tab: "settings" };
  if (rest.length === 2 && section === "evaluators") {
    return { type: "suite-settings", suiteId, tab: "evaluators" };
  }
  if (section !== "cases") return null;
  if (rest.length === 2)
    return { type: "suite-settings", suiteId, tab: "cases" };
  if (rest.length === 3 && testCaseId === "new") {
    return { type: "case-new", suiteId };
  }
  if (rest.length === 3 && testCaseId) {
    return { type: "case-settings", suiteId, testCaseId };
  }
  if (rest.length === 4 && testCaseId && leaf === "evaluators") {
    return { type: "case-evaluators", suiteId, testCaseId };
  }
  return null;
}

const SETTINGS_TAB_SEGMENT: Record<SuiteSettingsRouteTab, string> = {
  settings: "",
  cases: "/cases",
  evaluators: "/evaluators",
};

/** The path for a page-per-layer route under `prefix`, the inverse of the parsers above. */
export function buildEvalNavRoutePath(
  prefix: string,
  route: EvalNavRoute,
): string {
  if (route.type === "evaluate-runs") return `${prefix}/runs`;
  const suite = `${prefix}/suite/${encodeURIComponent(route.suiteId)}`;
  switch (route.type) {
    case "suite-settings":
      return `${suite}/settings${SETTINGS_TAB_SEGMENT[route.tab]}`;
    case "case-new":
      return `${suite}/settings/cases/new`;
    case "case-settings":
      return `${suite}/settings/cases/${encodeURIComponent(route.testCaseId)}`;
    case "case-evaluators":
      return `${suite}/settings/cases/${encodeURIComponent(route.testCaseId)}/evaluators`;
  }
  const testRun = `${suite}/runs/${encodeURIComponent(route.runId)}/cases/${encodeURIComponent(route.testCaseId)}`;
  switch (route.type) {
    case "test-run":
      return route.target
        ? `${testRun}?${new URLSearchParams({ target: route.target })}`
        : testRun;
    case "iteration":
      return `${testRun}/iter/${encodeURIComponent(route.iterationId)}`;
    case "test-run-edit":
      return route.step
        ? `${testRun}/edit?${new URLSearchParams({ step: route.step })}`
        : `${testRun}/edit`;
  }
}
