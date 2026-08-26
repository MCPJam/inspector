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

export function useAppRouteContext(): AppRouteContext {
  const context = useContext(AppRouteReactContext);
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return context ?? useOutletContext<AppRouteContext>();
}
