import type { EvalRoute } from "@/lib/eval-route-types";

export function shouldAutoOpenPlaygroundCasesView(params: {
  route: EvalRoute;
  exploreSuiteId: string | null;
  isSuiteDetailsLoading: boolean;
  runsCount: number;
}) {
  const { route, exploreSuiteId, isSuiteDetailsLoading, runsCount } = params;

  if (!exploreSuiteId || isSuiteDetailsLoading) {
    return false;
  }

  if (route.type === "list") {
    return true;
  }

  if (route.type !== "suite-overview") {
    return false;
  }

  if (route.suiteId !== exploreSuiteId || route.view === "test-cases") {
    return false;
  }

  return runsCount === 0;
}
