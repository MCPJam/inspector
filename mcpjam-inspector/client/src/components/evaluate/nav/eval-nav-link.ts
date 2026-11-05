/**
 * Links between the evals pages, and how the reader reached each one.
 *
 * The address names the page; how you got there rides in router state, so a
 * shared link never carries someone's browsing history (plan E2). Every page
 * reads it here, for its Back button and for `eval_nav_page_viewed`.
 */
import { useContext, useEffect, useRef } from "react";
import {
  UNSAFE_DataRouterContext,
  UNSAFE_LocationContext,
  type DataRouter,
} from "react-router";
import type { EvalRoute, SuiteSettingsRouteTab } from "@/lib/eval-route-types";
import {
  buildEvaluatePath,
  navigateApp,
  scopeNavigationTarget,
} from "@/lib/app-navigation";
import { getAppRouter } from "../../../router-ref";
import type { EvalNavPageId } from "./eval-nav-pages";
import {
  EVAL_NAV_ARRIVAL_STATE_KEY,
  trackEvalNav,
  type EvalNavArrival,
} from "./eval-nav-events";

/** The page a link was followed from: what Back says, and where it goes. */
export type EvalNavFrom = { label: string; path: string };

type EvalNavState = {
  evalNavFrom?: EvalNavFrom;
  [EVAL_NAV_ARRIVAL_STATE_KEY]?: EvalNavArrival;
};

const ARRIVALS: readonly EvalNavArrival[] = [
  "link",
  "crumb",
  "back",
  "redirect",
  "direct",
];

function currentPath(): string {
  const location = getAppRouter()?.state?.location ?? window.location;
  return `${location.pathname}${location.search}`;
}

/**
 * Open an evals page, tagged with how it was reached: a link (the default)
 * or a crumb. `fromLabel` finishes "Back to …" on the page that opens.
 */
export function navigateEvalNav(
  route: EvalRoute,
  options: { via?: "link" | "crumb"; fromLabel?: string; replace?: boolean },
): void {
  const target = scopeNavigationTarget(buildEvaluatePath(route));
  const state: EvalNavState = {
    [EVAL_NAV_ARRIVAL_STATE_KEY]: options.via ?? "link",
    ...(options.fromLabel
      ? { evalNavFrom: { label: options.fromLabel, path: currentPath() } }
      : {}),
  };
  const router = getAppRouter();
  if (router) {
    void router.navigate(target, { state, replace: options.replace });
    return;
  }
  navigateApp(target, { replace: options.replace });
}

/** Open an evals page, remembering this one as the way back. */
export function openEvalNavPage(route: EvalRoute, fromLabel: string): void {
  navigateEvalNav(route, { fromLabel });
}

function readState(value: unknown): EvalNavState {
  if (!value || typeof value !== "object") return {};
  const state = value as EvalNavState;
  const from = state.evalNavFrom;
  const arrival = state[EVAL_NAV_ARRIVAL_STATE_KEY];
  return {
    ...(from && typeof from.label === "string" && typeof from.path === "string"
      ? { evalNavFrom: from }
      : {}),
    ...(arrival && ARRIVALS.includes(arrival)
      ? { [EVAL_NAV_ARRIVAL_STATE_KEY]: arrival }
      : {}),
  };
}

/**
 * How a location was reached. A history move (POP) is Back or Forward once
 * the router has shown another entry, and a direct open (a pasted link, a
 * reload) before that. Other navigations carry their tag: a link, a crumb or
 * a redirect.
 */
export function evalNavArrivalOf(
  state: unknown,
  navigationType: string,
  seenEarlierEntry: boolean,
): EvalNavArrival {
  if (navigationType === "POP") return seenEarlierEntry ? "back" : "direct";
  return readState(state)[EVAL_NAV_ARRIVAL_STATE_KEY] ?? "link";
}

type Entry = { key: string; via: EvalNavArrival };

/** Each router's current entry and how it was reached, kept as it navigates. */
const currentEntry = new WeakMap<DataRouter, Entry>();

function routerEntry(router: DataRouter): Entry {
  const known = currentEntry.get(router);
  if (known) return known;
  const { location, historyAction } = router.state;
  const entry = {
    key: location.key,
    via: evalNavArrivalOf(location.state, historyAction, false),
  };
  currentEntry.set(router, entry);
  router.subscribe(({ location: next, historyAction: action }) => {
    if (currentEntry.get(router)?.key === next.key) return;
    currentEntry.set(router, {
      key: next.key,
      via: evalNavArrivalOf(next.state, action, true),
    });
  });
  return entry;
}

/** How this page was reached. Outside a router, a direct open. */
export function useEvalNavArrival(): {
  from: EvalNavFrom | null;
  arrivedVia: EvalNavArrival;
  pathname: string;
} {
  const context = useContext(UNSAFE_LocationContext);
  const router = useContext(UNSAFE_DataRouterContext)?.router;
  const location = context?.location;
  const state: unknown = location?.state;
  const entry = router ? routerEntry(router) : null;
  const arrivedVia: EvalNavArrival = !context
    ? "direct"
    : entry?.key === context.location.key
      ? entry.via
      : evalNavArrivalOf(state, context.navigationType, Boolean(entry));
  return {
    from: readState(state).evalNavFrom ?? null,
    arrivedVia,
    pathname: location?.pathname ?? window.location.pathname,
  };
}

/**
 * Fire `eval_nav_page_viewed` once per visit, and only for the new screens
 * (`enabled` is the flag). A visit is one page, tab and path: a new query
 * string alone (a model picked on a test run) is the same visit.
 */
export function useEvalNavPageViewed(
  page: EvalNavPageId,
  enabled: boolean,
  tab?: SuiteSettingsRouteTab,
): void {
  const { arrivedVia, pathname } = useEvalNavArrival();
  const sent = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const visit = `${page}:${tab ?? ""}:${pathname}`;
    if (sent.current === visit) return;
    sent.current = visit;
    trackEvalNav("eval_nav_page_viewed", {
      page,
      ...(tab ? { tab } : {}),
      arrived_via: arrivedVia,
    });
  }, [enabled, page, tab, pathname, arrivedVia]);
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
