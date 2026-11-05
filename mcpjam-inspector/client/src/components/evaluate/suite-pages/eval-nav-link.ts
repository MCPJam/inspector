/**
 * Links between the evals pages, and where each one was opened from.
 *
 * The address names the page; how you got there rides in router state, so a
 * shared link never carries someone's browsing history (plan E2). A page
 * reads that state for its Back button and for `eval_nav_page_viewed`.
 */
import { useContext, useEffect, useRef } from "react";
import { UNSAFE_LocationContext } from "react-router";
import type { EvalRoute } from "@/lib/eval-route-types";
import {
  buildEvaluatePath,
  navigateApp,
  scopeNavigationTarget,
} from "@/lib/app-navigation";
import { getAppRouter } from "../../../router-ref";
import type { EvalNavPageId } from "../nav/eval-nav-pages";
import { trackEvalNav, type EvalNavArrival } from "../nav/eval-nav-events";

/** The page a link was followed from: what Back says, and where it goes. */
export type EvalNavFrom = { label: string; path: string };

type EvalNavState = {
  evalNavFrom?: EvalNavFrom;
  evalNavArrival?: EvalNavArrival;
};

function currentPath(): string {
  const location = getAppRouter()?.state?.location ?? window.location;
  return `${location.pathname}${location.search}`;
}

/**
 * Open an evals page, remembering this one as the way back.
 *
 * `fromLabel` finishes "Back to …" on the page that opens, e.g. "suite".
 */
export function openEvalNavPage(route: EvalRoute, fromLabel: string): void {
  const target = scopeNavigationTarget(buildEvaluatePath(route));
  const state: EvalNavState = {
    evalNavFrom: { label: fromLabel, path: currentPath() },
    evalNavArrival: "link",
  };
  const router = getAppRouter();
  if (router) {
    void router.navigate(target, { state });
    return;
  }
  navigateApp(target);
}

function readState(value: unknown): EvalNavState {
  if (!value || typeof value !== "object") return {};
  const state = value as EvalNavState;
  const from = state.evalNavFrom;
  return {
    ...(from && typeof from.label === "string" && typeof from.path === "string"
      ? { evalNavFrom: from }
      : {}),
    ...(state.evalNavArrival ? { evalNavArrival: state.evalNavArrival } : {}),
  };
}

/** The router state this page was opened with. Empty outside a router. */
export function useEvalNavArrival(): {
  from: EvalNavFrom | null;
  arrivedVia: EvalNavArrival;
  locationKey: string;
} {
  const location = useContext(UNSAFE_LocationContext)?.location;
  const state = readState(location?.state);
  return {
    from: state.evalNavFrom ?? null,
    arrivedVia: state.evalNavArrival ?? "direct",
    locationKey: location?.key ?? "",
  };
}

/**
 * Fire `eval_nav_page_viewed` once per visit, and only for the new screens
 * (`enabled` is the flag). A visit is one history entry.
 */
export function useEvalNavPageViewed(
  page: EvalNavPageId,
  enabled: boolean,
): void {
  const { arrivedVia, locationKey } = useEvalNavArrival();
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const visit = `${page}:${locationKey}`;
    if (sent.current === visit) return;
    sent.current = visit;
    trackEvalNav("eval_nav_page_viewed", { page, arrived_via: arrivedVia });
  }, [enabled, page, locationKey, arrivedVia]);
}

/** Back: to the page this one was opened from, else to `fallback`. */
export function useEvalNavBack(fallback: { label: string; route: EvalRoute }): {
  label: string;
  go: () => void;
} {
  const { from } = useEvalNavArrival();
  if (from) {
    return { label: `Back to ${from.label}`, go: () => navigateApp(from.path) };
  }
  return {
    label: `Back to ${fallback.label}`,
    go: () => navigateApp(buildEvaluatePath(fallback.route)),
  };
}
