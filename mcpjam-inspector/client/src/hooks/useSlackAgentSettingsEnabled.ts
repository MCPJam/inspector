import { useFeatureFlagEnabled } from "posthog-js/react";

export const SLACK_AGENT_ORG_SETTINGS_FEATURE_FLAG = "slack-agent-org-settings";

/**
 * Org-level settings for the Slack agent — connected workspaces, channel
 * bindings, capability toggles, activity — are gated behind a PostHog flag
 * while the backend rolls out. Gates EVERY client exposure: the tab in the org
 * settings strip AND the section component itself, so a user who types
 * `/organizations/:id/slack` directly does not get in either.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load — treated as
 * OFF (fail-closed) by {@link useSlackAgentSettingsEnabled}. A guard that
 * wants to distinguish "loading" from "off" — to avoid bouncing a flagged-in
 * user who cold-loads the URL — should use
 * {@link useSlackAgentSettingsEnabledState} instead.
 */
export function useSlackAgentSettingsEnabled(): boolean {
  return useFeatureFlagEnabled(SLACK_AGENT_ORG_SETTINGS_FEATURE_FLAG) === true;
}

/** Tri-state variant: `undefined` while PostHog flags are still loading. */
export function useSlackAgentSettingsEnabledState(): boolean | undefined {
  return useFeatureFlagEnabled(SLACK_AGENT_ORG_SETTINGS_FEATURE_FLAG);
}
