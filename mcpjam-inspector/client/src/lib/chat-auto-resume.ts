/**
 * Shared `sendAutomaticallyWhen` predicate for every chat surface that runs the
 * agent loop client-side — the agent side panel / Home takeover (via
 * `agent-chat-instances`) and the Playground (via `use-chat-session`).
 *
 * Both surfaces resume a paused turn under the same rule: once the last step's
 * tool calls have all settled (the auto-send carries their results back so the
 * agent loop continues) OR once its approval requests have been answered. The
 * AI SDK ships one predicate for each half; this composes them behind the BUG-4
 * guard so the two surfaces share a single definition and can't drift apart.
 *
 * The approval branch is deliberately NOT gated on the current
 * `requireToolApproval` flag: a pill minted while the toggle was on must still
 * resume the turn if the user flips it off before answering, and the predicate
 * is inert when the message holds no approval requests.
 */
import type { UIMessage } from "@ai-sdk/react";
import {
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import {
  ASK_USER_TOOL_NAME,
  readAskUserAnswerFromOutput,
} from "./webmcp/ask-user-store";

/**
 * True while any tool call in the last assistant message's current step is
 * still `approval-requested` — the Approve/Deny pill is on screen and the user
 * has NOT answered it yet.
 *
 * BUG-4: the SDK's completion predicates can report a step "done" while such a
 * pill is still pending. `lastAssistantMessageIsCompleteWithToolCalls` skips
 * `providerExecuted` parts, and host built-ins like bash ARE provider-executed
 * — so a step that also holds an auto-fulfilled WebMCP `ui_*` tool looks
 * complete even though the bash approval is unanswered. Auto-resuming there
 * answers the approval FOR the user and unmounts the buttons mid-decision (they
 * render only while the part is `approval-requested`; see tool-part.tsx).
 * Because the predicate runs on every stream/message update and the Chat
 * instance persists across turns, whether the resume wins the race with the
 * human is timing-dependent — hence the intermittent flash.
 *
 * Gating on this parks the turn until the user actually clicks; the answer
 * moves the part off `approval-requested` (→ `approval-responded`, or
 * `output-available` for UI-tool fulfillment), so the gate can never
 * permanently stall the turn.
 *
 * Mirrors the SDK's scoping — parts after the last `step-start` of the last
 * assistant message — so it weighs exactly the parts those predicates weigh.
 */
export function lastStepHasPendingApproval({
  messages,
}: {
  messages: UIMessage[];
}): boolean {
  const message = messages[messages.length - 1];
  if (!message || message.role !== "assistant") return false;
  const parts = message.parts;
  let lastStepStartIndex = -1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]?.type === "step-start") lastStepStartIndex = i;
  }
  return parts
    .slice(lastStepStartIndex + 1)
    .some((part) => isToolUIPart(part) && part.state === "approval-requested");
}

/**
 * True when the last step settled a `ui_ask_user` call as DISMISSED — the user
 * pressed Stop, typed something else, or walked away.
 *
 * Abandonment is not a prompt. The dismissal still has to be RECORDED (a
 * `tool_use` with no result is an invalid message history for both Anthropic
 * and OpenAI, so the next request would fail), but resuming on it makes the
 * model answer the very question the user just walked away from — a reply
 * streaming in after Stop. Recording a result and generating from it are
 * separate steps; only the second is unsolicited.
 *
 * Read from the recorded output rather than in-memory state so it survives a
 * reload and needs no bookkeeping to clean up. It cannot stall the turn: once
 * the user sends anything, the last assistant message is a different one and
 * this is false again.
 *
 * Scoped like the SDK's own predicates — parts after the last `step-start`.
 */
export function lastStepDismissedAskUser({
  messages,
}: {
  messages: UIMessage[];
}): boolean {
  const message = messages[messages.length - 1];
  if (!message || message.role !== "assistant") return false;
  const parts = message.parts;
  let lastStepStartIndex = -1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]?.type === "step-start") lastStepStartIndex = i;
  }
  return parts.slice(lastStepStartIndex + 1).some((part) => {
    // BOTH part shapes: the server registers `ui_*` as dynamic tools, so the
    // streamed part is `dynamic-tool` carrying `toolName` — matching only the
    // static `tool-<name>` type would silently never fire in production
    // (which is exactly what the SDK canary caught).
    const candidate = part as {
      type?: string;
      toolName?: string;
      output?: unknown;
    };
    const isAskUser =
      candidate.type === `tool-${ASK_USER_TOOL_NAME}` ||
      (candidate.type === "dynamic-tool" &&
        candidate.toolName === ASK_USER_TOOL_NAME);
    if (!isAskUser) return false;
    return readAskUserAnswerFromOutput(candidate.output)?.kind === "dismissed";
  });
}

/**
 * `sendAutomaticallyWhen` for the client-driven agent loop: resume the turn
 * once the last step's tool calls settle or its approvals are answered, but
 * NEVER while an approval pill is still pending (BUG-4 — see
 * `lastStepHasPendingApproval`), and never off an abandoned clarifying
 * question (see `lastStepDismissedAskUser`).
 */
export function shouldAutoResumeTurn(options: {
  messages: UIMessage[];
}): boolean {
  if (lastStepHasPendingApproval(options)) return false;
  if (lastStepDismissedAskUser(options)) return false;
  if (lastAssistantMessageIsCompleteWithToolCalls(options)) return true;
  return lastAssistantMessageIsCompleteWithApprovalResponses(options);
}
