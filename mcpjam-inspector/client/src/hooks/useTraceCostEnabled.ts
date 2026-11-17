import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * Rollout gate for dollar cost on traces. Capture is not gated: spans carry
 * cost evidence either way, and this flag only decides whether the timeline
 * shows it.
 *
 * Fail-closed: `useFeatureFlagEnabled` returns `undefined` while flags load
 * and when the flag does not exist, and both read as off, so the timeline
 * renders exactly what it did before the flag existed.
 */
export const TRACE_COST_FEATURE_FLAG = "trace-cost";

export function useTraceCostEnabled(): boolean {
  return useFeatureFlagEnabled(TRACE_COST_FEATURE_FLAG) === true;
}
