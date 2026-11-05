import type { SuiteSettingsTab } from "@/lib/eval-route-types";
import { track } from "@/lib/analytics";
import type { EvaluateNavPageName } from "./evaluate-nav-pages";

/** How the user reached a page; read from router navigation state. */
export type EvalNavArrival = "link" | "crumb" | "back" | "redirect" | "direct";
export type EvalTutorialTrigger = "first_visit" | "first_suite" | "menu";

/** Router state key a link sets to say how it was followed. */
export const EVAL_NAV_ARRIVAL_STATE_KEY = "evalNavArrival";
/** Router state key naming the page a link left, to be the next page's Back target. */
export const EVAL_NAV_BACK_STATE_KEY = "evalNavBack";
/**
 * Router state key for the stored step index the case editor opens at. State,
 * not address: the editor's URL stays the case's URL (E2).
 */
export const EVAL_NAV_FOCUS_STEP_STATE_KEY = "evalNavFocusStep";

/** Properties of each navigation-rework event, from the plan's analytics table. */
export interface EvalNavEventProps {
  eval_nav_page_viewed: {
    page: EvaluateNavPageName;
    tab?: SuiteSettingsTab;
    arrived_via: EvalNavArrival;
  };
  eval_nav_redirected: { from_kind: string; to_kind: string; matched: boolean };
  eval_tutorial_shown: { trigger: EvalTutorialTrigger; step: number };
  eval_tutorial_completed: { trigger: EvalTutorialTrigger; step: number };
  eval_tutorial_dismissed: { trigger: EvalTutorialTrigger; step: number };
  eval_edit_from_test_run: { surface: "list" | "page" | "preview_step" };
  eval_execution_preview_opened: { surface: "editor" | "test_run" };
}

export type EvalNavEventName = keyof EvalNavEventProps;

/** `track()` with each event's properties checked; tagged with the Evaluate location. */
export function trackEvalNav<E extends EvalNavEventName>(
  event: E,
  props: EvalNavEventProps[E],
): void {
  track(event, { location: "evaluate_nav", ...props });
}
