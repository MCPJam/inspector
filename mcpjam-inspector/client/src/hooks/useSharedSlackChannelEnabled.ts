import { useFeatureFlagEnabled } from "posthog-js/react";

export const SHARED_SLACK_CHANNEL_FEATURE_FLAG = "shared-slack-channel-enabled";

/**
 * Home-tab shared Slack Connect channel card. Same PostHog key the backend
 * gates writes with (`shared-slack-channel-enabled`). One lever, both repos.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load, and that is
 * treated as OFF. Fail-closed is the right default for a dark feature: the
 * cost is a missing card until flags arrive, not a flash of a provision
 * button an unflagged org should never see.
 */
export function useSharedSlackChannelEnabled(): boolean {
  return useFeatureFlagEnabled(SHARED_SLACK_CHANNEL_FEATURE_FLAG) === true;
}
