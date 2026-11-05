import { useCallback, useContext } from "react";
import { UNSAFE_LocationContext, UNSAFE_NavigationContext } from "react-router";
import type { EvalRoute } from "@/lib/eval-route-types";
import {
  buildEvaluatePath,
  navigateApp,
  scopeNavigationTarget,
} from "@/lib/app-navigation";
import { EVAL_NAV_ARRIVAL_STATE_KEY } from "../nav/evaluate-nav-host";
import type { EvalNavArrival } from "../nav/evaluate-nav-events";

/**
 * Router state key for the stored step index the case editor should open at,
 * set when a step in the execution preview is clicked. State, not address:
 * the editor's URL stays the case's URL (E2).
 */
export const EVAL_NAV_FOCUS_STEP_STATE_KEY = "evalNavFocusStep";

/** Navigate to an Evaluate route, telling the next page how it was reached. */
export function useEvaluateNavNavigate() {
  const navigator = useContext(UNSAFE_NavigationContext)?.navigator;
  const pathname = useContext(UNSAFE_LocationContext)?.location.pathname;
  return useCallback(
    (
      route: EvalRoute,
      arrival: EvalNavArrival,
      options?: { focusStepIndex?: number; replace?: boolean },
    ) => {
      const path = buildEvaluatePath(route);
      if (!navigator) {
        navigateApp(path, { replace: options?.replace });
        return;
      }
      const state = {
        [EVAL_NAV_ARRIVAL_STATE_KEY]: arrival,
        ...(options?.focusStepIndex === undefined
          ? {}
          : { [EVAL_NAV_FOCUS_STEP_STATE_KEY]: options.focusStepIndex }),
      };
      const target = scopeNavigationTarget(path, pathname);
      if (options?.replace) navigator.replace(target, state);
      else navigator.push(target, state);
    },
    [navigator, pathname],
  );
}
