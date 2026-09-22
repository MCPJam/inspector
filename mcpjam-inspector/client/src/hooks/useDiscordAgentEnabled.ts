import { useFeatureFlagEnabled } from "posthog-js/react";

export const DISCORD_AGENT_FEATURE_FLAG = "discord-agent";

/**
 * The Discord agent is dark while it rolls out — the bot is installed in a
 * single test guild and its org-level settings do not exist yet. This gates
 * the only client exposure it has: the Integrations card.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load, and that is
 * treated as OFF, same as the Slack agent flag. Fail-closed matters more than
 * usual here because the card's action is an INSTALL link: showing it early
 * would invite someone to add a bot to their server that cannot yet answer
 * them.
 */
export function useDiscordAgentEnabled(): boolean {
  return useFeatureFlagEnabled(DISCORD_AGENT_FEATURE_FLAG) === true;
}
