import { useFeatureFlagEnabled } from "posthog-js/react";

export const EVENTS_FEATURE_FLAG = "mcp-events-enabled";

/** Preserve loading so direct links wait for PostHog before redirecting. */
export function useEventsEnabledState(): boolean | undefined {
  return useFeatureFlagEnabled(EVENTS_FEATURE_FLAG);
}
