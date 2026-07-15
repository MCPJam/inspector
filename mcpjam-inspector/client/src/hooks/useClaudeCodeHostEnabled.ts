import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for the "Claude Code" host template in the New Host
 * template picker (CreateHostDialog). Flag off ⇒ the template is hidden from
 * the grid, so we can iterate on the CLI host profile (roots + form
 * elicitation, no widget rendering) before exposing it to everyone — no
 * deploy needed to flip it on. Currently scoped to @mcpjam.com users.
 *
 * `useFeatureFlagEnabled` returns `undefined` while flags load — treated as
 * off (`=== true`) so the template never flickers into the picker before
 * PostHog resolves.
 */
export const CLAUDE_CODE_HOST_FEATURE_FLAG = "claude-code-host-enabled";

export function useClaudeCodeHostEnabled(): boolean {
  return useFeatureFlagEnabled(CLAUDE_CODE_HOST_FEATURE_FLAG) === true;
}
