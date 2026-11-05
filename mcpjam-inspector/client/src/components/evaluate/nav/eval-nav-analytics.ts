/**
 * Typed analytics for the per-layer Evaluate pages.
 *
 * Page views count per eval layer on today's pages too (`ui: "legacy"`), so
 * the new pages have a baseline to be measured against. Props carry ids only:
 * never suite names, case titles, prompts or model output.
 */
import { useCallback, useContext, useEffect, useRef } from "react";
import { UNSAFE_LocationContext } from "react-router";
import type { ClientAnalyticsEventName } from "@/shared/analytics-events";
import { track } from "@/lib/analytics";
import { buildEvaluatePath } from "@/lib/app-navigation";
import type { EvalRoute, SuiteSettingsTab } from "@/lib/eval-route-types";
import { parseProjectPath } from "@/lib/project-route";
import { isDraftTestCaseId } from "@/components/evals/draft-test-case";
import { useEvalNavArrival, type EvalNavArrival } from "./eval-nav-state";

export const EVAL_NAV_EVENTS = {
  pageViewed: "eval_nav_page_viewed",
  redirected: "eval_nav_redirected",
  editFromTestRun: "eval_edit_from_test_run",
  executionPreviewOpened: "eval_execution_preview_opened",
} as const satisfies Record<string, ClientAnalyticsEventName>;

export type EvalNavPageName =
  | "suites"
  | "runs"
  | "suite"
  | "suite_settings"
  | "new_test_case"
  | "test_case"
  | "test_case_evaluators"
  | "suite_run"
  | "test_run"
  | "iteration"
  | "test_run_edit";

export type EvalNavArrivedVia = EvalNavArrival | "direct";
/** Exported for the tutorial; its event names are registered with it. */
export type EvalTutorialTrigger = "first_visit" | "first_suite" | "menu";

export interface EvalNavEventProps {
  eval_nav_page_viewed: {
    page: EvalNavPageName;
    /** suite_settings only; null elsewhere. */
    tab: SuiteSettingsTab | null;
    arrived_via: EvalNavArrivedVia;
    /** "legacy" while today's page renders, "nav" for a new page. Separates the baseline. */
    ui: "legacy" | "nav";
  };
  eval_nav_redirected: {
    /** Route kind the old address parsed to; "unknown" when it did not parse. */
    from_kind: EvalRoute["type"] | "unknown";
    /** Route kind it was rewritten to; null when unmatched. */
    to_kind: EvalRoute["type"] | null;
    matched: boolean;
  };
  eval_edit_from_test_run: { surface: "list" | "page" | "preview_step" };
  eval_execution_preview_opened: { surface: "editor" | "test_run" };
}
export type EvalNavEventName = keyof EvalNavEventProps;

/** track() with location "evaluate_tab", the props above, and project_id. */
export function trackEvalNav<E extends EvalNavEventName>(
  event: E,
  props: EvalNavEventProps[E] & { project_id: string | null },
): void {
  track(event, { ...props, location: "evaluate_tab" });
}

const PAGE_NAMES: Record<EvalRoute["type"], EvalNavPageName | null> = {
  list: "suites",
  "evaluate-runs": "runs",
  "suite-overview": "suite",
  "suite-settings": "suite_settings",
  "suite-edit": "suite_settings",
  "case-new": "new_test_case",
  "case-settings": "test_case",
  "test-detail": "test_case",
  "test-edit": "test_case",
  "case-evaluators": "test_case_evaluators",
  "run-detail": "suite_run",
  "test-run": "test_run",
  iteration: "iteration",
  "test-run-edit": "test_run_edit",
  create: null,
  "eval-server": null,
  "commit-detail": null,
};

/** The page name for a route, or null for routes that are not a nav page. */
export function evalNavPageName(route: EvalRoute): EvalNavPageName | null {
  if (route.type === "test-edit") {
    if (route.checks) return "test_case_evaluators";
    if (isDraftTestCaseId(route.testId)) return "new_test_case";
  }
  if (route.type === "run-detail") {
    if (route.iteration) return "iteration";
    if (route.testCaseId) return "test_run";
  }
  return PAGE_NAMES[route.type];
}

/**
 * Fires eval_nav_page_viewed once per distinct logical path while `enabled`.
 * Reads arrived_via from router state ("direct" when absent).
 */
export function useEvalNavPageView(
  route: EvalRoute,
  options: { projectId: string | null; ui: "legacy" | "nav"; enabled: boolean },
): void {
  const { projectId, ui, enabled } = options;
  const { via } = useEvalNavArrival();
  const page = evalNavPageName(route);
  const tab = route.type === "suite-settings" ? route.tab : null;
  const path = buildEvaluatePath(route);
  const lastKey = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !page) return;
    const key = `${projectId ?? ""}|${path}`;
    if (lastKey.current === key) return;
    lastKey.current = key;
    trackEvalNav("eval_nav_page_viewed", {
      page,
      tab,
      arrived_via: via,
      ui,
      project_id: projectId,
    });
  }, [enabled, page, path, projectId, tab, ui, via]);
}

/**
 * Page views for today's run report drawers, which open from local state
 * without a URL change. The project comes from the current address.
 */
export function useEvalNavDrawerView(): (
  page: "test_run" | "iteration",
) => void {
  const locationContext = useContext(UNSAFE_LocationContext);
  const pathname =
    locationContext?.location.pathname ??
    (typeof window === "undefined" ? "" : window.location.pathname);
  const projectId = parseProjectPath(pathname)?.projectId ?? null;
  return useCallback(
    (page) => {
      trackEvalNav("eval_nav_page_viewed", {
        page,
        tab: null,
        arrived_via: "link",
        ui: "legacy",
        project_id: projectId,
      });
    },
    [projectId],
  );
}
