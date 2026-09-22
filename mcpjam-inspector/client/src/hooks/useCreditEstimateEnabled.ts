import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for the pre-run credit estimate hint (the info icon
 * beside "Run all", the per-case quick-run controls, the template editor's
 * draft-run button, and swarm journey cards).
 *
 * Fail-closed: `useFeatureFlagEnabled` returns `undefined` both while flags load
 * AND when the flag does not exist, and both are treated as "not enabled"
 * (`=== true`). Flag off means the hint does not render AND the estimate query
 * never fires — the backend queries are read-only and fully authorized, so the
 * gate exists purely to control rollout and query volume, not access.
 */
export const CREDIT_ESTIMATE_FEATURE_FLAG = "credit-estimate-enabled";

export function useCreditEstimateEnabled(): boolean {
  return useFeatureFlagEnabled(CREDIT_ESTIMATE_FEATURE_FLAG) === true;
}
