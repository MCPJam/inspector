import { useFeatureFlagEnabled } from "posthog-js/react";
import { useClaudeCodeHostEnabled } from "./useClaudeCodeHostEnabled";
import { useCodexHostEnabled } from "./useCodexHostEnabled";
import { useCopilotCliEnabled } from "./useCopilotCliEnabled";
import { useCursorHostEnabled } from "./useCursorHostEnabled";

/**
 * Whether this member can run any client on a native harness: a paired client
 * through `client-agent-loop`, or a harness template through its runtime's own
 * flag. The usage surfaces show the trial's turns left only then. A flag still
 * loading reads as off, so nothing flickers in before PostHog resolves.
 */
export function useNativeHarnessEnabled(): boolean {
  const agentLoop = useFeatureFlagEnabled("client-agent-loop") === true;
  const claudeCode = useClaudeCodeHostEnabled();
  const codex = useCodexHostEnabled();
  const cursor = useCursorHostEnabled();
  const copilotCli = useCopilotCliEnabled() === true;
  return agentLoop || claudeCode || codex || cursor || copilotCli;
}
