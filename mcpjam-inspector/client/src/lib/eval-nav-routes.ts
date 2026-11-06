/**
 * The per-layer Evaluate pages: their logical paths and the page each one
 * opens until its new screen ships.
 *
 * New addresses are accepted for everyone. While a kind has no new page (or
 * its flag is off) it renders today's equivalent, so a shared link never lands
 * on the suites list by accident.
 */
import { draftTestCaseId } from "@/components/evals/draft-test-case";
import type {
  EvalNavRoute,
  EvalNavRouteType,
  EvalRoute,
  LegacyEvalRoute,
} from "./eval-route-types";

export const EVAL_NAV_ROUTE_TYPES = [
  "evaluate-runs",
  "suite-settings",
  "case-new",
  "case-settings",
  "case-evaluators",
  "test-run",
  "iteration",
  "test-run-edit",
] as const satisfies readonly EvalNavRouteType[];

const EVAL_NAV_ROUTE_TYPE_SET: ReadonlySet<string> = new Set(
  EVAL_NAV_ROUTE_TYPES,
);

export function isEvalNavRoute(route: EvalRoute): route is EvalNavRoute {
  return EVAL_NAV_ROUTE_TYPE_SET.has(route.type);
}

const EVALUATE_PREFIX = "/evaluate";

function suitePath(suiteId: string): string {
  return `${EVALUATE_PREFIX}/suite/${encodeURIComponent(suiteId)}`;
}

function testRunPath(route: {
  suiteId: string;
  runId: string;
  testCaseId: string;
}): string {
  return `${suitePath(route.suiteId)}/runs/${encodeURIComponent(
    route.runId,
  )}/cases/${encodeURIComponent(route.testCaseId)}`;
}

/** The logical /evaluate path for a new kind (ids encoded, no project prefix). */
export function buildEvalNavPath(route: EvalNavRoute): string {
  switch (route.type) {
    case "evaluate-runs":
      return `${EVALUATE_PREFIX}/runs`;
    case "suite-settings": {
      const base = `${suitePath(route.suiteId)}/settings`;
      const path = route.tab === "settings" ? base : `${base}/${route.tab}`;
      return route.importJob
        ? `${path}?${new URLSearchParams({ importJob: route.importJob })}`
        : path;
    }
    case "case-new":
      return `${suitePath(route.suiteId)}/settings/cases/new`;
    case "case-settings":
      return `${suitePath(route.suiteId)}/settings/cases/${encodeURIComponent(
        route.testCaseId,
      )}`;
    case "case-evaluators":
      return `${suitePath(route.suiteId)}/settings/cases/${encodeURIComponent(
        route.testCaseId,
      )}/evaluators`;
    case "test-run": {
      const query = route.target
        ? `?${new URLSearchParams({ target: route.target })}`
        : "";
      return `${testRunPath(route)}${query}`;
    }
    case "test-run-edit":
      return `${testRunPath(route)}/edit`;
    case "iteration":
      return `${testRunPath(route)}/iter/${encodeURIComponent(
        route.iterationId,
      )}`;
  }
}

/**
 * Today's page for a new kind. The page map renders it while the kind has no
 * new page, and the /evals builders degrade to it.
 */
export function legacyEvalRouteFor(route: EvalNavRoute): LegacyEvalRoute {
  switch (route.type) {
    case "evaluate-runs":
      return { type: "list" };
    case "suite-settings":
      return route.tab === "cases"
        ? {
            type: "suite-overview",
            suiteId: route.suiteId,
            view: "test-cases",
            ...(route.importJob ? { importJob: route.importJob } : {}),
          }
        : { type: "suite-edit", suiteId: route.suiteId };
    case "case-new":
      return {
        type: "test-edit",
        suiteId: route.suiteId,
        testId: draftTestCaseId("describe"),
      };
    case "case-settings":
    case "test-run-edit":
      return {
        type: "test-edit",
        suiteId: route.suiteId,
        testId: route.testCaseId,
      };
    case "case-evaluators":
      return {
        type: "test-edit",
        suiteId: route.suiteId,
        testId: route.testCaseId,
        checks: true,
      };
    case "test-run":
      return {
        type: "run-detail",
        suiteId: route.suiteId,
        runId: route.runId,
        testCaseId: route.testCaseId,
      };
    case "iteration":
      return {
        type: "run-detail",
        suiteId: route.suiteId,
        runId: route.runId,
        testCaseId: route.testCaseId,
        iteration: route.iterationId,
      };
  }
}
