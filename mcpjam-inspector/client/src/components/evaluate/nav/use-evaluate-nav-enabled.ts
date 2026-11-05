import { useFeatureFlagEnabled } from "posthog-js/react";

/** Gates Evaluate's page-per-layer screens; read in the browser only. */
export const EVALUATE_NAV_FEATURE_FLAG = "evaluate-nav-enabled";

/**
 * `undefined` while PostHog loads, so a page can wait instead of showing the
 * old screen and then swapping it.
 */
export function useEvaluateNavEnabled(): boolean | undefined {
  return useFeatureFlagEnabled(EVALUATE_NAV_FEATURE_FLAG);
}
