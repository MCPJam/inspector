import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog KILL SWITCH for the in-app agent chat (home hero/thread, the agent
 * side panel, and the `ui_*` WebMCP tool catalog registration that backs it).
 *
 * Deliberately fail-OPEN, unlike the repo's usual pre-launch gates (see
 * `useSkillsEnabled`, which is fail-closed `=== true` so an unlaunched surface
 * stays dark while flags hydrate or the flag doesn't exist). Agent chat is
 * already launched: treating the hydration-window `undefined` as "off" would
 * dark-ship a live feature on every page load and churn the ui_* catalog
 * through a register → unregister → register cycle while PostHog loads. So
 * `undefined` (flags loading, flag absent) ⇒ ON; only an explicit `false`
 * — the operator flipping the kill switch — turns the feature off.
 */
export const AGENT_CHAT_FEATURE_FLAG = "agent-chat-enabled";

export function useAgentChatEnabled(): boolean {
  return useFeatureFlagEnabled(AGENT_CHAT_FEATURE_FLAG) !== false;
}
