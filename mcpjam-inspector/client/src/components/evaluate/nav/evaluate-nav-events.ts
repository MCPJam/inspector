import type { SuiteSettingsTab } from "@/lib/eval-route-types";
import { track } from "@/lib/analytics";
import type { EvaluateNavPageName } from "./evaluate-nav-pages";

/** How the user reached a page; read from router navigation state. */
export type EvalNavArrival = "link" | "crumb" | "back" | "redirect" | "direct";
export type EvalTutorialTrigger = "first_visit" | "first_suite" | "menu";

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
