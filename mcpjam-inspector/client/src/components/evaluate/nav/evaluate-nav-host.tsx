import { useContext, useEffect, useMemo, type ReactNode } from "react";
import { UNSAFE_LocationContext } from "react-router";
import { useEvaluateRouteFromUrl } from "@/lib/eval-route-url";
import { EvaluateTutorialProvider } from "../landing/evaluate-tutorial";
import {
  resolveEvaluatePage,
  toCurrentEvalRoute,
  type CurrentEvalRoute,
} from "./evaluate-nav-pages";
import { trackEvalNav, type EvalNavArrival } from "./evaluate-nav-events";
import { useEvaluateNavEnabled } from "./use-evaluate-nav-enabled";

/** Router state key a link sets to say how it was followed. */
export const EVAL_NAV_ARRIVAL_STATE_KEY = "evalNavArrival";

/**
 * Renders the new page for the current route when the flag is on and that
 * page exists, and `children` (today's Evaluate tab) otherwise. It waits for
 * the flag only on routes that have a new page.
 */
export function EvaluateNavHost({
  projectId,
  children,
}: {
  projectId?: string | null;
  children: ReactNode;
}) {
  const route = useEvaluateRouteFromUrl();
  const resolved = useMemo(() => resolveEvaluatePage(route), [route]);
  const navEnabled = useEvaluateNavEnabled();
  const arrivedVia = readArrival(
    useContext(UNSAFE_LocationContext)?.location.state,
  );
  const showsNewPage = Boolean(resolved?.element) && navEnabled === true;
  const page = showsNewPage ? resolved?.page : undefined;
  const tab = route.type === "suite-settings" ? route.tab : undefined;

  useEffect(() => {
    if (!page) return;
    trackEvalNav("eval_nav_page_viewed", {
      page,
      ...(tab ? { tab } : {}),
      arrived_via: arrivedVia,
    });
  }, [route, page, tab, arrivedVia]);

  const body = !resolved?.element
    ? children
    : navEnabled === undefined
      ? null
      : navEnabled
        ? resolved.element
        : children;
  return (
    <EvaluateTutorialProvider
      enabled={navEnabled === true}
      projectId={projectId}
    >
      {body}
    </EvaluateTutorialProvider>
  );
}

/** The parsed route as today's Evaluate tab renders it. */
export function useEvaluateCurrentRoute(): CurrentEvalRoute {
  const route = useEvaluateRouteFromUrl();
  return useMemo(() => toCurrentEvalRoute(route), [route]);
}

function readArrival(state: unknown): EvalNavArrival {
  if (typeof state !== "object" || state === null) return "direct";
  const value: unknown = Reflect.get(state, EVAL_NAV_ARRIVAL_STATE_KEY);
  return value === "link" ||
    value === "crumb" ||
    value === "back" ||
    value === "redirect"
    ? value
    : "direct";
}
