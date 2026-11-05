import { createElement, type ComponentType, type ReactElement } from "react";
import type {
  EvalRoute,
  EvaluateNavRoute,
  EvaluateNavRouteType,
} from "@/lib/eval-route-types";
import { isEvaluateNavRoute } from "@/lib/evaluate-nav-route-path";
import { draftTestCaseId } from "../../evals/draft-test-case";
import { EvaluateLandingPage } from "../landing/evaluate-landing-page";
import { IterationPage } from "../test-run/iteration-page";
import { TestRunPage } from "../test-run/test-run-page";
import { SuiteSettingsPage } from "../suite-settings/suite-settings-page";
import { CaseEditorPage } from "../case-steps/case-editor-page";

/** A route kind that today's Evaluate tab renders. */
export type CurrentEvalRoute = Exclude<EvalRoute, EvaluateNavRoute>;

/** The `page` property of `eval_nav_page_viewed`. */
export type EvaluateNavPageName =
  | "evaluate_suites"
  | "evaluate_runs"
  | "suite_settings"
  | "case_new"
  | "case_settings"
  | "case_evaluators"
  | "test_run"
  | "test_run_edit"
  | "iteration";

export interface EvaluateNavPageEntry<R extends EvalRoute> {
  page: EvaluateNavPageName;
  /** Today's route for the same content: shown with the flag off, or until `Page` exists. */
  currentRoute: (route: R) => CurrentEvalRoute;
  /** The new page. Phase 2 sets this; it renders only with the flag on. */
  Page?: ComponentType<{ route: R }>;
}

/** `/evaluate` itself: the landing's Suites tab, a route today's tab also renders. */
type EvaluateLandingRoute = Extract<EvalRoute, { type: "list" }>;

export type EvaluateNavPageMap = {
  [K in EvaluateNavRouteType]: EvaluateNavPageEntry<
    Extract<EvaluateNavRoute, { type: K }>
  >;
} & { evaluate: EvaluateNavPageEntry<EvaluateLandingRoute> };

/**
 * Route kind → page (E3). Each Phase 2 page adds its `Page` here instead of
 * editing `EvaluateTab.tsx`; until then every entry opens today's page, which
 * is also what a new-style link opens with the flag off (PD3).
 */
export const EVALUATE_NAV_PAGES: EvaluateNavPageMap = {
  evaluate: {
    page: "evaluate_suites",
    currentRoute: (route) => route,
    Page: EvaluateLandingPage,
  },
  "evaluate-runs": {
    page: "evaluate_runs",
    currentRoute: () => ({ type: "list" }),
    Page: EvaluateLandingPage,
  },
  "suite-settings": {
    page: "suite_settings",
    currentRoute: ({ suiteId, tab }) =>
      tab === "cases"
        ? { type: "suite-overview", suiteId, view: "test-cases" }
        : { type: "suite-edit", suiteId },
    Page: SuiteSettingsPage,
  },
  "case-new": {
    page: "case_new",
    currentRoute: ({ suiteId }) => ({
      type: "test-edit",
      suiteId,
      testId: draftTestCaseId("describe"),
    }),
    Page: CaseEditorPage,
  },
  "case-settings": {
    page: "case_settings",
    currentRoute: ({ suiteId, caseId }) => ({
      type: "test-edit",
      suiteId,
      testId: caseId,
    }),
    Page: CaseEditorPage,
  },
  "case-evaluators": {
    page: "case_evaluators",
    currentRoute: ({ suiteId, caseId }) => ({
      type: "test-edit",
      suiteId,
      testId: caseId,
      checks: true,
    }),
  },
  "test-run": {
    page: "test_run",
    currentRoute: ({ suiteId, runId, caseId }) => ({
      type: "run-detail",
      suiteId,
      runId,
      testCaseId: caseId,
    }),
    Page: TestRunPage,
  },
  "test-run-edit": {
    page: "test_run_edit",
    currentRoute: ({ suiteId, caseId }) => ({
      type: "test-edit",
      suiteId,
      testId: caseId,
    }),
  },
  iteration: {
    page: "iteration",
    currentRoute: ({ suiteId, runId, caseId, iterationId }) => ({
      type: "run-detail",
      suiteId,
      runId,
      testCaseId: caseId,
      iteration: iterationId,
    }),
    Page: IterationPage,
  },
};

/** One route's entry, with the route already applied. */
export interface ResolvedEvaluateNavPage {
  page: EvaluateNavPageName;
  currentRoute: CurrentEvalRoute;
  /** The new page for this route, when Phase 2 has built it. */
  element?: ReactElement;
}

export function resolveEvaluateNavPage(
  route: EvaluateNavRoute,
): ResolvedEvaluateNavPage {
  const pages = EVALUATE_NAV_PAGES;
  switch (route.type) {
    case "evaluate-runs":
      return applyEntry(pages["evaluate-runs"], route);
    case "suite-settings":
      return applyEntry(pages["suite-settings"], route);
    case "case-new":
      return applyEntry(pages["case-new"], route);
    case "case-settings":
      return applyEntry(pages["case-settings"], route);
    case "case-evaluators":
      return applyEntry(pages["case-evaluators"], route);
    case "test-run":
      return applyEntry(pages["test-run"], route);
    case "test-run-edit":
      return applyEntry(pages["test-run-edit"], route);
    case "iteration":
      return applyEntry(pages.iteration, route);
  }
}

/** The nav page for any route that has one: the nav kinds and `/evaluate`. */
export function resolveEvaluatePage(
  route: EvalRoute,
): ResolvedEvaluateNavPage | null {
  if (route.type === "list")
    return applyEntry(EVALUATE_NAV_PAGES.evaluate, route);
  return isEvaluateNavRoute(route) ? resolveEvaluateNavPage(route) : null;
}

function applyEntry<R extends EvalRoute>(
  entry: EvaluateNavPageEntry<R>,
  route: R,
): ResolvedEvaluateNavPage {
  const { Page } = entry;
  return {
    page: entry.page,
    currentRoute: entry.currentRoute(route),
    ...(Page ? { element: createElement(Page, { route }) } : {}),
  };
}

/** The route today's Evaluate tab should render for any parsed route. */
export function toCurrentEvalRoute(route: EvalRoute): CurrentEvalRoute {
  return isEvaluateNavRoute(route)
    ? resolveEvaluateNavPage(route).currentRoute
    : route;
}
