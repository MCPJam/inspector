import { useFeatureFlagEnabled } from "posthog-js/react";

export const PLATFORM_POST_LAUNCH_FEATURE_FLAG = "platform-post-launch";

/**
 * The launch surfaces that are not public yet — MCP, Scheduled and GitHub —
 * as choices in the run history "Platform" filter.
 *
 * Visibility only, and only of the CHIPS: a run launched from one of those
 * surfaces still lands in the table and still wears its badge, because the
 * origin is stamped server-side and hiding a filter cannot unstamp it. This
 * hides the three chips that offer a filter nobody outside the launch can act
 * on yet.
 *
 * Fail-closed, like every sibling flag hook: `useFeatureFlagEnabled` is
 * `undefined` while flags load, and that is treated as off, so a cold load
 * shows the four shipped chips rather than flickering through seven.
 */
export function usePlatformPostLaunchEnabled(): boolean {
  return useFeatureFlagEnabled(PLATFORM_POST_LAUNCH_FEATURE_FLAG) === true;
}
