/**
 * The persisted chat-session transcript envelope, and the tool-call projection
 * the swarm grader and the production-checks worker both run over it.
 */

import type { TranscriptToolCall } from "@/shared/eval-matching";
import { extractToolCallsFromConversation } from "@/shared/eval-tool-call-projection";

/**
 * Shape of a stored chat-session transcript envelope. Kept loose because the
 * backend codegen isn't present here; consumers depend on `messages` (for
 * tool-call extraction + final-message derivation) and `spans` (for tool-error
 * classification via `extractToolErrors`).
 */
export interface ChatSessionEnvelope {
  traceVersion?: number;
  messages: Array<{ role: string; content: unknown }>;
  spans?: Array<Record<string, unknown>>;
  prompts?: unknown[];
  widgetSnapshots?: unknown[];
}

/**
 * Walk messages and pull out tool calls in the order they appear.
 *
 * The walker itself is `shared/eval-tool-call-projection.ts`, shared with the
 * eval runner. There is never an AI SDK `steps` array here: the envelope is a
 * persisted transcript, not a live run.
 */
export function extractToolCallsFromEnvelopeMessages(
  messages: ChatSessionEnvelope["messages"],
): TranscriptToolCall[] {
  return extractToolCallsFromConversation({ messages }).map((toolCall) => ({
    toolName: toolCall.toolName,
    ...(toolCall.toolCallId ? { toolCallId: toolCall.toolCallId } : {}),
    arguments: (toolCall.arguments ?? {}) as Record<string, unknown>,
  }));
}
