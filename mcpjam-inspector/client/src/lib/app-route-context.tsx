import { createContext, useContext } from "react";
import { useOutletContext } from "react-router";

/**
 * The bag of app state every route element reads (active project, servers,
 * handlers…). Extracted from `App.tsx` so the routing components —
 * the project boundary, the legacy normalizer — can read it without importing
 * the App monolith, which would drag PostHog, Convex and every store into
 * their module graph (and their tests).
 */
export type AppRouteContext = Record<string, any>;

export const AppRouteReactContext = createContext<AppRouteContext | null>(null);

/**
 * Both readers are called UNCONDITIONALLY, then preferred in order.
 *
 * The `??` shorthand around a hook call reads like a cheap fallback and is a
 * Rules of Hooks violation: it changes which hooks run between renders. It
 * happens not to crash — `useOutletContext` is a bare `useContext`, which
 * allocates no hook slot — but it earns a development warning and it is the
 * kind of thing that stops being harmless the moment either reader grows.
 *
 * Two readers because App renders its routes two ways: through an `<Outlet>`
 * under the router, and directly in the no-Router path (local mode and a good
 * many component tests). The React context is preferred because App provides
 * it in both.
 *
 * The result stays non-nullable, matching `useOutletContext`'s own generic and
 * the ~45 call sites that destructure it: every path that renders a route
 * provides one of the two. A component mounted outside both is a programming
 * error, and it failed the same way before this hook existed.
 */
export function useAppRouteContext(): AppRouteContext {
  const providedContext = useContext(AppRouteReactContext);
  const outletContext = useOutletContext<AppRouteContext>();
  return providedContext ?? outletContext;
}
