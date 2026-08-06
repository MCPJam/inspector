import { useFeatureFlagEnabled } from "posthog-js/react";

export const SLACK_AGENT_ORG_SETTINGS_FEATURE_FLAG = "slack-agent-org-settings";

/**
 * Org-level settings for the Slack agent — connected workspaces, channel
 * bindings, capability toggles, activity — are gated behind a PostHog flag
 * while the backend rolls out. Gates EVERY client exposure: the tab in the org
 * settings strip AND the section component itself, so a user who types
 * `/organizations/:id/slack` directly does not get in either.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load, and that is
 * treated as OFF. Fail-closed is the right default for a dark feature: the
 * cost is that a flagged-in admin who cold-loads the URL lands on the org
 * overview until flags arrive, which is a settings page either way.
 */
export function useSlackAgentSettingsEnabled(): boolean {
  return useFeatureFlagEnabled(SLACK_AGENT_ORG_SETTINGS_FEATURE_FLAG) === true;
}
