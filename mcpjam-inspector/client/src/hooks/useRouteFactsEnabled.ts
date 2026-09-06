import { useFeatureFlagEnabled } from "posthog-js/react";

export const ROUTE_FACTS_FEATURE_FLAG = "evaluate-route-facts-enabled";

/**
 * Per-case route + mismatch facts on the Evaluate run page.
 *
 * Fail-closed: `useFeatureFlagEnabled` is `undefined` while flags load, and
 * that is treated as off. Flag off means no computation and no DOM — the
 * section is not mounted, so a flag-off page issues zero extra work.
 */
export function useRouteFactsEnabled(): boolean {
  return useFeatureFlagEnabled(ROUTE_FACTS_FEATURE_FLAG) === true;
}
