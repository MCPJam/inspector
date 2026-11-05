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
 * Navigate to an Evaluate route and record how it was followed, so the next
 * page's `eval_nav_page_viewed` says `link` or `crumb` rather than `direct`.
 * Falls back to `navigateApp` outside a router, like `useAppNavigate`.
 */
export function useEvaluateNavLink() {
  const navigator = useContext(UNSAFE_NavigationContext)?.navigator;
  const pathname = useContext(UNSAFE_LocationContext)?.location.pathname;
  return useCallback(
    (
      route: EvalRoute,
      arrival: Extract<EvalNavArrival, "link" | "crumb">,
      options?: { replace?: boolean },
    ) => {
      const target = scopeNavigationTarget(buildEvaluatePath(route), pathname);
      if (!navigator) {
        navigateApp(target, options);
        return;
      }
      const state = { [EVAL_NAV_ARRIVAL_STATE_KEY]: arrival };
      if (options?.replace) navigator.replace(target, state);
      else navigator.push(target, state);
    },
    [navigator, pathname],
  );
}
