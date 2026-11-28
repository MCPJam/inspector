import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for the "OpenCode" host template in the New Host
 * template picker (CreateHostDialog) and the `?template=` link. The backend's
 * `opencode-harness` gate reads the same flag key before an OpenCode turn
 * runs, so hiding the template and refusing the turn are one lever, as for
 * `useCursorHostEnabled`. `undefined` while flags load, which callers treat as
 * off so the template never flickers into the picker.
 */
export const OPENCODE_HOST_FEATURE_FLAG = "opencode-host-enabled";

/** Tri-state flag value for route guards that must wait for PostHog. */
export function useOpenCodeHostEnabledState(): boolean | undefined {
  return useFeatureFlagEnabled(OPENCODE_HOST_FEATURE_FLAG);
}

export function useOpenCodeHostEnabled(): boolean {
  return useOpenCodeHostEnabledState() === true;
}
