/**
 * The one way Evaluate pages navigate between each other. It writes router
 * state the next page reads: how the link was followed (for
 * `eval_nav_page_viewed`), the page being left (for Back), and the step the
 * case editor opens at. The address stays the route alone (E2).
 */
import { useCallback, useContext } from "react";
import { UNSAFE_LocationContext, UNSAFE_NavigationContext } from "react-router";
import type { EvalRoute } from "@/lib/eval-route-types";
import {
  buildEvaluatePath,
  navigateApp,
  scopeNavigationTarget,
} from "@/lib/app-navigation";
import {
  EVAL_NAV_ARRIVAL_STATE_KEY,
  EVAL_NAV_BACK_STATE_KEY,
  EVAL_NAV_FOCUS_STEP_STATE_KEY,
  type EvalNavArrival,
} from "./evaluate-nav-events";

/** The arrivals an in-app control records; redirects set their own. */
export type EvalNavFollow = Extract<EvalNavArrival, "link" | "crumb" | "back">;

export interface EvalNavNavigateOptions {
  replace?: boolean;
  /** Stored step index the case editor opens scrolled to and expanded at. */
  focusStepIndex?: number;
  /**
   * Names the page being left, as in "Back to {place}", so the next page's
   * Back returns to this address rather than its default.
   */
  backPlace?: string;
}

/** Where Back leads: an app path and the place name its label uses. */
export interface EvalNavBackTarget {
  path: string;
  place: string;
}

export type EvalNavigate = (
  /** An Evaluate route, or an app path a Back target stored. */
  to: EvalRoute | string,
  arrival: EvalNavFollow,
  options?: EvalNavNavigateOptions,
) => void;

/**
 * Navigate to an Evaluate route and record how it was followed. Outside a
 * router it falls back to `navigateApp`, which cannot carry state.
 */
export function useEvaluateNavNavigate(): EvalNavigate {
  const navigator = useContext(UNSAFE_NavigationContext)?.navigator;
  const location = useContext(UNSAFE_LocationContext)?.location;
  const pathname = location?.pathname;
  const search = location?.search ?? "";
  return useCallback(
    (to, arrival, options = {}) => {
      const path = typeof to === "string" ? to : buildEvaluatePath(to);
      const target = scopeNavigationTarget(path, pathname);
      if (!navigator) {
        navigateApp(target, { replace: options.replace });
        return;
      }
      const state = {
        [EVAL_NAV_ARRIVAL_STATE_KEY]: arrival,
        ...(options.focusStepIndex === undefined
          ? {}
          : { [EVAL_NAV_FOCUS_STEP_STATE_KEY]: options.focusStepIndex }),
        ...(options.backPlace && pathname
          ? {
              [EVAL_NAV_BACK_STATE_KEY]: {
                path: `${pathname}${search}`,
                place: options.backPlace,
              },
            }
          : {}),
      };
      if (options.replace) navigator.replace(target, state);
      else navigator.push(target, state);
    },
    [navigator, pathname, search],
  );
}

function useLocationState(): unknown {
  return useContext(UNSAFE_LocationContext)?.location.state;
}

/** The page the user came from, when the link that brought them named it. */
export function useEvalNavBackTarget(): EvalNavBackTarget | null {
  return readBackTarget(useLocationState());
}

/** The stored step index the case editor should open at, if a link set one. */
export function useEvalNavFocusStep(): number | null {
  const state = useLocationState();
  if (typeof state !== "object" || state === null) return null;
  const value: unknown = Reflect.get(state, EVAL_NAV_FOCUS_STEP_STATE_KEY);
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

export function readBackTarget(state: unknown): EvalNavBackTarget | null {
  if (typeof state !== "object" || state === null) return null;
  const value: unknown = Reflect.get(state, EVAL_NAV_BACK_STATE_KEY);
  if (typeof value !== "object" || value === null) return null;
  const path: unknown = Reflect.get(value, "path");
  const place: unknown = Reflect.get(value, "place");
  if (typeof place !== "string" || !place) return null;
  // App-relative paths only: state must never send Back off the app.
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//")
  )
    return null;
  return { path, place };
}
