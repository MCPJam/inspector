import { useFeatureFlagEnabled } from "posthog-js/react";

/** Client flag for the Evaluate navigation rework (E10). */
export const EVALUATE_NAV_FEATURE_FLAG = "evaluate-nav-enabled";

/**
 * `undefined` while PostHog loads flags. New pages wait for a boolean, so a
 * user never sees today's page flash before the new one.
 */
export function useEvaluateNavEnabled(): boolean | undefined {
  return useFeatureFlagEnabled(EVALUATE_NAV_FEATURE_FLAG);
}
