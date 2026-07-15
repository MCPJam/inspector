import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for the Tools-tab tool-quality lint badges. Flag off ⇒
 * no badges render and the client never subscribes to the backend lint query,
 * so the feature can be rolled out per-user / by percentage without a deploy.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load — treated as off
 * (`=== true`) so the UI never flickers badges on before PostHog resolves.
 */
export const TOOL_QUALITY_FEATURE_FLAG = "tool-quality-enabled";

export function useToolQualityEnabled(): boolean {
  return useFeatureFlagEnabled(TOOL_QUALITY_FEATURE_FLAG) === true;
}
