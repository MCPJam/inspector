import type { EvalRoute } from "@/lib/eval-route-types";

function buildCasesOverviewRoute(suiteId: string): EvalRoute {
  return {
    type: "suite-overview",
    suiteId,
    view: "test-cases",
  };
}

function getRouteSuiteId(route: EvalRoute): string | null {
  switch (route.type) {
    case "suite-overview":
    case "run-detail":
    case "test-detail":
    case "test-edit":
    case "suite-edit":
      return route.suiteId;
    default:
      return null;
  }
}

export function getPlaygroundCasesRedirect(params: {
  route: EvalRoute;
  exploreSuiteId: string | null;
  isSuiteDetailsLoading: boolean;
  isSuiteRunsLoading: boolean;
  testCaseIds: string[];
  runIds: string[];
  iterationRunIds: string[];
}) {
  const {
    route,
    exploreSuiteId,
    isSuiteDetailsLoading,
    isSuiteRunsLoading,
    testCaseIds,
    runIds,
    iterationRunIds,
  } = params;

  if (!exploreSuiteId) {
    return null;
  }

  const fallbackRoute = buildCasesOverviewRoute(exploreSuiteId);

  if (route.type === "list") {
    return fallbackRoute;
  }

  const routeSuiteId = getRouteSuiteId(route);
  if (routeSuiteId && routeSuiteId !== exploreSuiteId) {
    return fallbackRoute;
  }

  if (route.type === "suite-overview") {
    if (route.view === "test-cases" || route.view === "executions") {
      return null;
    }

    return fallbackRoute;
  }

  if (route.type === "test-detail" || route.type === "test-edit") {
    if (isSuiteDetailsLoading) {
      return null;
    }

    return testCaseIds.includes(route.testId) ? null : fallbackRoute;
  }

  if (route.type === "run-detail") {
    if (isSuiteRunsLoading) {
      return null;
    }

    return runIds.includes(route.runId) || iterationRunIds.includes(route.runId)
      ? null
      : fallbackRoute;
  }

  return null;
}
