/**
 * Hosted-chat MRTR resume helpers (MCP 2026-07-28 §12.5, browser consumer leg).
 *
 * A hosted chat turn whose tool call returns `input_required` SUSPENDS: the
 * worker persists the operation to a durable continuation, emits a
 * `data-mrtr-input-required` part, and finishes the stream with the tool-call
 * left unresolved in the transcript. The browser answers by re-driving an
 * ordinary chat turn that carries an `mrtrResume` descriptor — the server then
 * drives the retry leg, splices the real tool result into that tool-call slot,
 * and resumes the agent loop.
 *
 * The descriptor names WHICH tool-call slot the driven result fills, but the
 * data part deliberately does NOT carry a `toolCallId`: the suspend happens
 * deep inside `tool.execute`, and the part is a safe display of the round, not
 * a transcript pointer. The browser therefore resolves the slot from its own
 * message history — which is exactly the history it will resend — using the
 * same "unresolved tool-call" rule the server re-validates with
 * (`hasUnresolvedToolCall`). A wrong id cannot escalate: the continuation
 * binding is enforced server-side, so it only mis-slots the caller's own
 * history, and the server rejects an id that is absent or already answered.
 */

import type { UIMessage } from "@ai-sdk/react";
import type { MrtrElicitationResponse } from "@/shared/mrtr-continuation";

/**
 * Tool part states that mean "this call has NOT been answered yet". The AI SDK
 * marks a resolved call `output-available` / `output-error`; anything earlier
 * is still open, which is precisely the slot a suspended MRTR operation left
 * behind.
 */
const UNRESOLVED_TOOL_STATES = new Set([
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded",
]);

interface ToolPartLike {
  type: string;
  toolCallId?: unknown;
  toolName?: unknown;
  state?: unknown;
}

function isToolPart(part: unknown): part is ToolPartLike {
  if (typeof part !== "object" || part === null) return false;
  const type = (part as { type?: unknown }).type;
  return (
    typeof type === "string" &&
    (type.startsWith("tool-") || type === "dynamic-tool")
  );
}

/** The tool name a part refers to (`tool-<name>` parts encode it in the type). */
function toolNameOf(part: ToolPartLike): string | undefined {
  if (typeof part.toolName === "string") return part.toolName;
  return part.type.startsWith("tool-")
    ? part.type.slice("tool-".length)
    : undefined;
}

/**
 * Find the tool-call slot a suspended MRTR round belongs to: the most recent
 * unresolved tool call in the transcript, preferring one whose tool name
 * matches the round's `operationLabel`.
 *
 * Returns `undefined` when nothing matches — the caller must then fail fast
 * (withdraw the continuation) rather than send a resume the server would
 * reject, or worse, splice a result into an unrelated call.
 */
export function findUnresolvedMrtrToolCallId(
  messages: readonly UIMessage[],
  operationLabel?: string
): string | undefined {
  let fallback: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (!isToolPart(part)) continue;
      if (typeof part.toolCallId !== "string" || !part.toolCallId) continue;
      if (
        typeof part.state === "string" &&
        !UNRESOLVED_TOOL_STATES.has(part.state)
      ) {
        continue;
      }
      if (operationLabel && toolNameOf(part) === operationLabel) {
        return part.toolCallId;
      }
      // Keep the newest unresolved call as the fallback, but keep scanning for
      // a name match: a multi-call step can leave several open slots and only
      // the matching one belongs to this round.
      fallback ??= part.toolCallId;
    }
  }
  return fallback;
}

/** The `mrtrResume` descriptor a resuming chat request carries. */
export interface MrtrChatResumeBody {
  toolCallId: string;
  serverId: string;
  continuationId: string;
  round: number;
  responses: Record<string, MrtrElicitationResponse>;
}

export function buildMrtrChatResumeBody(args: {
  toolCallId: string;
  serverId: string;
  continuationId: string;
  round: number;
  responses: Record<string, MrtrElicitationResponse>;
}): { mrtrResume: MrtrChatResumeBody } {
  return {
    mrtrResume: {
      toolCallId: args.toolCallId,
      serverId: args.serverId,
      continuationId: args.continuationId,
      round: args.round,
      responses: args.responses,
    },
  };
}
