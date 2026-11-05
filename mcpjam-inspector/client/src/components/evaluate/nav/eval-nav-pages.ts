import { useMemo } from "react";
import type { EvalRoute } from "@/lib/eval-route-types";
import { useEvaluateRouteFromUrl } from "@/lib/eval-route-url";
import { draftTestCaseId } from "../../evals/draft-test-case";

/** The pages of the evals flow, as `eval_nav_page_viewed` names them. */
export type EvalNavPageId =
  | "suites"
  | "runs"
  | "suite"
  | "suite-settings"
  | "case-new"
  | "case"
  | "case-evaluators"
  | "suite-run"
  | "test-run"
  | "iteration"
  | "test-run-edit";

type EvalFlowRouteKind =
  | "list"
  | "evaluate-runs"
  | "suite-overview"
  | "suite-settings"
  | "case-new"
  | "case-settings"
  | "case-evaluators"
  | "run-detail"
  | "test-run"
  | "iteration"
  | "test-run-edit";

type RouteOf<K extends EvalRoute["type"]> = Extract<EvalRoute, { type: K }>;

export type EvalNavPageEntry<K extends EvalFlowRouteKind> = {
  page: EvalNavPageId;
  /**
   * The route today's screen renders for this address. A page built for the
   * new flow replaces it when the flag is on; with the flag off, a new-style
   * link still lands on the matching old screen.
   */
  todayRoute: (route: RouteOf<K>) => EvalRoute;
};

const same = <R extends EvalRoute>(route: R): EvalRoute => route;

/**
 * One entry per page of the evals flow. A page lands by changing its own
 * entry here, not the routing in `EvaluateTab.tsx`.
 */
export const EVAL_NAV_PAGES: { [K in EvalFlowRouteKind]: EvalNavPageEntry<K> } =
  {
    list: { page: "suites", todayRoute: same },
    "evaluate-runs": { page: "runs", todayRoute: () => ({ type: "list" }) },
    "suite-overview": { page: "suite", todayRoute: same },
    "suite-settings": {
      page: "suite-settings",
      todayRoute: ({ suiteId, tab }) =>
        tab === "cases"
          ? { type: "suite-overview", suiteId, view: "test-cases" }
          : { type: "suite-edit", suiteId },
    },
    "case-new": {
      page: "case-new",
      todayRoute: ({ suiteId }) => ({
        type: "test-edit",
        suiteId,
        testId: draftTestCaseId("describe"),
      }),
    },
    "case-settings": {
      page: "case",
      todayRoute: ({ suiteId, testCaseId }) => ({
        type: "test-edit",
        suiteId,
        testId: testCaseId,
      }),
    },
    "case-evaluators": {
      page: "case-evaluators",
      todayRoute: ({ suiteId, testCaseId }) => ({
        type: "test-edit",
        suiteId,
        testId: testCaseId,
        checks: true,
      }),
    },
    "run-detail": { page: "suite-run", todayRoute: same },
    "test-run": {
      page: "test-run",
      todayRoute: ({ suiteId, runId, testCaseId }) => ({
        type: "run-detail",
        suiteId,
        runId,
        testCaseId,
      }),
    },
    iteration: {
      page: "iteration",
      todayRoute: ({ suiteId, runId, testCaseId, iterationId }) => ({
        type: "run-detail",
        suiteId,
        runId,
        testCaseId,
        iteration: iterationId,
      }),
    },
    "test-run-edit": {
      page: "test-run-edit",
      todayRoute: ({ suiteId, testCaseId }) => ({
        type: "test-edit",
        suiteId,
        testId: testCaseId,
      }),
    },
  };

function isFlowRoute(route: EvalRoute): route is RouteOf<EvalFlowRouteKind> {
  return Object.hasOwn(EVAL_NAV_PAGES, route.type);
}

export type EvalNavResolution = {
  /** The route the address names. */
  route: EvalRoute;
  /** The route the screen renders. */
  pageRoute: EvalRoute;
  /** Null for routes outside the flow, such as create. */
  page: EvalNavPageId | null;
};

function pageEntry<K extends EvalFlowRouteKind>(kind: K): EvalNavPageEntry<K> {
  return EVAL_NAV_PAGES[kind];
}

export function resolveEvalNavPage(route: EvalRoute): EvalNavResolution {
  if (!isFlowRoute(route)) return { route, pageRoute: route, page: null };
  const entry = pageEntry(route.type);
  return { route, pageRoute: entry.todayRoute(route), page: entry.page };
}

/** Evaluate's route from the URL, resolved to the screen that renders it. */
export function useEvaluateNavPage(): EvalNavResolution {
  const route = useEvaluateRouteFromUrl();
  return useMemo(() => resolveEvalNavPage(route), [route]);
}
