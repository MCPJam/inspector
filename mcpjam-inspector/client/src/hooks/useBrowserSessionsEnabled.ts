import { useFeatureFlagEnabled } from "posthog-js/react";

/** Dark launch for durable browser identity and watched Playground sandboxes. */
export const BROWSER_SESSIONS_FEATURE_FLAG = "browser-sessions";

/** Fail closed while flags are still loading. */
export function useBrowserSessionsEnabled(): boolean {
  return useFeatureFlagEnabled(BROWSER_SESSIONS_FEATURE_FLAG) === true;
}
