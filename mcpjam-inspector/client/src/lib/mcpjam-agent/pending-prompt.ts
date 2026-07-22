/**
 * Shared contract for the "pending prompt" handoff between a session opener and
 * the thread that autosubmits it.
 *
 * When a caller mints a fresh agent session id and wants the thread to send a
 * first message on mount (the hero → thread swap, the home takeover, and the
 * Learning-tab guided tours), it stashes the message under a per-session
 * sessionStorage key. `McpjamAgentThread` peeks it for an optimistic bubble and
 * then consumes it exactly once. sessionStorage (not localStorage) so a stale
 * pending message can't leak across browser sessions.
 *
 * The stored shape is `{ text, fresh: true }`. The `fresh` flag distinguishes
 * "just minted + submitted" from "resumed via a Recent Chat pill" (which writes
 * no pending value); the thread refuses to autosubmit anything not marked fresh
 * so a resumed transcript never replays. Parsing/consumption stays in the
 * thread — this module owns only the key format and the write.
 */

export const PENDING_AGENT_PROMPT_KEY_PREFIX = "mcpjam:agent-pending:";

export function pendingAgentPromptKey(sessionId: string): string {
  return `${PENDING_AGENT_PROMPT_KEY_PREFIX}${sessionId}`;
}

/**
 * Stash a first message for `McpjamAgentThread` to autosubmit on mount.
 * Swallows quota/disabled-storage failures — worst case the thread opens on an
 * empty composer and the user retypes.
 */
export function writePendingAgentPrompt(sessionId: string, text: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      pendingAgentPromptKey(sessionId),
      JSON.stringify({ text, fresh: true }),
    );
  } catch {
    // Quota/disabled storage — non-fatal, see doc comment above.
  }
}

/**
 * Remove an unconsumed pending payload. Used by openers that abandon a session
 * before its thread mounts (takeover Back / New chat).
 */
export function clearPendingAgentPrompt(
  sessionId: string | null | undefined,
): void {
  if (!sessionId || typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(pendingAgentPromptKey(sessionId));
  } catch {
    // Quota/disabled storage — a stale entry is a no-op unless the user returns
    // to this exact session id.
  }
}
