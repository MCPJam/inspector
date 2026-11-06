/**
 * Which component renders each Evaluate route kind.
 *
 * A new page registers here by setting its entry's `Page`; EvaluateTab asks
 * `resolveEvalNavPage` what to render, so page work never edits the tab.
 */
import type { ComponentType } from "react";
import type {
  EvalNavRouteType,
  EvalRoute,
  LegacyEvalRoute,
} from "@/lib/eval-route-types";
import { isEvalNavRoute, legacyEvalRouteFor } from "@/lib/eval-nav-routes";
import type { EvalNavPageName } from "./eval-nav-analytics";
import { EvaluateLandingPage } from "../landing/evaluate-landing-page";
import { SuiteNavPage } from "../nav-suite/suite-nav-page";
import { SuiteRunNavPage } from "../nav-run/suite-run-nav-page";
import { TestRunPage } from "../test-run/test-run-page";
import { IterationPage } from "../test-run/iteration-page";

/** Route kinds a new page will own: the per-layer kinds plus the three existing pages being rebuilt. */
export type EvalNavPageRouteType =
  EvalNavRouteType | "list" | "suite-overview" | "run-detail";
export type EvalNavPageRoute = Extract<
  EvalRoute,
  { type: EvalNavPageRouteType }
>;

export interface EvalNavPageProps {
  /** The parsed route. Pages narrow it with a type guard on route.type. */
  route: EvalNavPageRoute;
  projectId: string | null;
}

export interface EvalNavPageEntry {
  /** eval_nav_page_viewed `page` for this kind. */
  analyticsPage: EvalNavPageName;
  /** The new page. null = today's page renders (via legacyEvalRouteFor for new kinds). */
  Page: ComponentType<EvalNavPageProps> | null;
}

export type EvalNavPages = Record<EvalNavPageRouteType, EvalNavPageEntry>;

/** One line per kind so page work on different kinds merges without conflicts. */
export const EVAL_NAV_PAGES: EvalNavPages = {
  list: { analyticsPage: "suites", Page: EvaluateLandingPage },
  "evaluate-runs": { analyticsPage: "runs", Page: EvaluateLandingPage },
  "suite-overview": { analyticsPage: "suite", Page: SuiteNavPage },
  "suite-settings": { analyticsPage: "suite_settings", Page: null },
  "case-new": { analyticsPage: "new_test_case", Page: null },
  "case-settings": { analyticsPage: "test_case", Page: null },
  "case-evaluators": { analyticsPage: "test_case_evaluators", Page: null },
  "run-detail": { analyticsPage: "suite_run", Page: SuiteRunNavPage },
  "test-run": { analyticsPage: "test_run", Page: TestRunPage },
  iteration: { analyticsPage: "iteration", Page: IterationPage },
  "test-run-edit": { analyticsPage: "test_run_edit", Page: null },
};

export type EvalNavResolution =
  /** Render today's EvaluateTab body with this route. */
  | { kind: "legacy"; route: LegacyEvalRoute }
  /** The flag is still loading and a new page exists: show the loading state, not the old page. */
  | { kind: "pending" }
  /** Render the new page. */
  | {
      kind: "page";
      Page: ComponentType<EvalNavPageProps>;
      route: EvalNavPageRoute;
    };

function isEvalNavPageRoute(route: EvalRoute): route is EvalNavPageRoute {
  return route.type in EVAL_NAV_PAGES;
}

/**
 * Forms today's pages keep for every flag value: the comparison page and the
 * pairwise diff (`?compareTo=`), the old `?case=` / `?iteration=` run forms
 * (2F redirects them to the new pages), and the suite page's non-runs views.
 */
function legacyOnly(route: EvalRoute): boolean {
  if (route.type === "run-detail") {
    return Boolean(
      route.comparison ||
      route.compareToRunId ||
      route.testCaseId ||
      route.iteration,
    );
  }
  return (
    route.type === "suite-overview" &&
    route.view !== undefined &&
    route.view !== "runs"
  );
}

function legacyResolution(route: EvalRoute): EvalNavResolution {
  return {
    kind: "legacy",
    route: isEvalNavRoute(route) ? legacyEvalRouteFor(route) : route,
  };
}

/**
 * page    when the entry has a Page and navEnabled === true
 * pending when the entry has a Page and navEnabled === undefined
 * legacy  otherwise: the route itself for legacy kinds, legacyEvalRouteFor(route) for new kinds.
 * Routes {@link legacyOnly} names are always legacy.
 */
export function resolveEvalNavPage(
  route: EvalRoute,
  navEnabled: boolean | undefined,
  pages: EvalNavPages = EVAL_NAV_PAGES,
): EvalNavResolution {
  if (legacyOnly(route)) return legacyResolution(route);
  if (!isEvalNavPageRoute(route)) return legacyResolution(route);
  const { Page } = pages[route.type];
  if (!Page || navEnabled === false) return legacyResolution(route);
  if (navEnabled === undefined) return { kind: "pending" };
  return { kind: "page", Page, route };
}
