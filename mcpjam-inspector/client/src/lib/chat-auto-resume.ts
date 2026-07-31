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
 * `sendAutomaticallyWhen` for the client-driven agent loop: resume the turn
 * once the last step's tool calls settle or its approvals are answered, but
 * NEVER while an approval pill is still pending (BUG-4 — see
 * `lastStepHasPendingApproval`).
 */
export function shouldAutoResumeTurn(options: {
  messages: UIMessage[];
}): boolean {
  if (lastStepHasPendingApproval(options)) return false;
  if (lastAssistantMessageIsCompleteWithToolCalls(options)) return true;
  return lastAssistantMessageIsCompleteWithApprovalResponses(options);
}
