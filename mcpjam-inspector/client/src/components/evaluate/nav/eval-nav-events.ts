import { track } from "@/lib/analytics";
import type { SuiteSettingsRouteTab } from "@/lib/eval-route-types";
import type { EvalNavPageId } from "./eval-nav-pages";

/** How the user reached a page. */
export type EvalNavArrival = "link" | "crumb" | "back" | "redirect" | "direct";

/** Router location state key that tells a page how the user arrived. */
export const EVAL_NAV_ARRIVAL_STATE_KEY = "evalNavArrival";

export type EvalNavArrivalState = {
  [EVAL_NAV_ARRIVAL_STATE_KEY]: EvalNavArrival;
};

export type EvalTutorialTrigger = "first_visit" | "first_suite" | "menu";

/** Properties of each navigation event; the names are registered in `shared/analytics-events.ts`. */
export type EvalNavEventProps = {
  eval_nav_page_viewed: {
    page: EvalNavPageId;
    tab?: SuiteSettingsRouteTab;
    arrived_via: EvalNavArrival;
  };
  eval_nav_redirected: { from_kind: string; to_kind: string; matched: boolean };
  eval_tutorial_shown: { trigger: EvalTutorialTrigger; step: number };
  eval_tutorial_completed: { trigger: EvalTutorialTrigger; step: number };
  eval_tutorial_dismissed: { trigger: EvalTutorialTrigger; step: number };
  eval_edit_from_test_run: { surface: "list" | "page" | "preview_step" };
  eval_execution_preview_opened: { surface: "editor" | "test_run" };
};

export type EvalNavEventName = keyof EvalNavEventProps;

export function trackEvalNav<E extends EvalNavEventName>(
  event: E,
  props: EvalNavEventProps[E],
): void {
  track(event, { ...props, location: "evaluate" });
}
