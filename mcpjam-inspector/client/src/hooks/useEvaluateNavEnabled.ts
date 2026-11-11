import { useFeatureFlagEnabled } from "posthog-js/react";

/** Gates the per-layer Evaluate pages (suite settings, test run, iteration). */
export const EVALUATE_NAV_FEATURE_FLAG = "evaluate-nav-enabled";

/**
 * Tri-state: undefined while PostHog flags load. Route consumers wait on
 * undefined rather than treating it as off, so the old page never flashes.
 */
export function useEvaluateNavEnabled(): boolean | undefined {
  return useFeatureFlagEnabled(EVALUATE_NAV_FEATURE_FLAG);
}
