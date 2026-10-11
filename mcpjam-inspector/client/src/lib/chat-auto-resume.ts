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
 *
 * The tool branch is bounded (`autoResumeStopReason`): it never resumes a
 * response the output-token limit cut off, nor a turn that has spent its step
 * budget. Without that bound a turn that reached the server's step ceiling
 * came back empty but "successful", its last step still looked settled, and
 * the browser re-posted it every few seconds for as long as the tab was open.
 * The approval branch needs no bound — each resume there is a user's click.
 */
import type { UIMessage } from "@ai-sdk/react";
import {
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import {
  countAssistantStepsSincePrompt,
  DEFAULT_TURN_MAX_STEPS,
} from "@/shared/turn-step-budget";
import {
  ASK_USER_TOOL_NAME,
  readAskUserAnswerFromOutput,
} from "./webmcp/ask-user-store";

/**
 * What the auto-resume decision needs beyond the messages.
 *
 * `finishReason` is how the LAST response ended, as the SDK reports it to the
 * chat's `onFinish` — the one place it reaches the browser; it is not stored on
 * the message. `maxSteps` is the ceiling the server enforces for this surface's
 * turns, so the browser stops exactly where the server would refuse.
 */
export interface AutoResumeInput {
  messages: UIMessage[];
  finishReason?: string;
  maxSteps?: number;
}

/** Why a resume that was otherwise due is being withheld. */
export type AutoResumeStopReason = "cut_off" | "step_limit";

/**
 * `step_limit` when the user message has already bought `maxSteps` steps: the
 * server cannot take another one, so a resume can only come back empty.
 * Checked first because the server also reports a turn that ran out of steps
 * as `length`. `cut_off` when the last response ended on the output-token
 * limit: whatever it was doing was truncated, and resuming asks the model to
 * do it again under the same limit. `null` when neither applies.
 */
export function autoResumeStopReason(
  input: AutoResumeInput,
): AutoResumeStopReason | null {
  const maxSteps = input.maxSteps ?? DEFAULT_TURN_MAX_STEPS;
  if (countAssistantStepsSincePrompt(input.messages) >= maxSteps) {
    return "step_limit";
  }
  if (input.finishReason === "length") return "cut_off";
  return null;
}

/** The one line the chat shows when an automatic resume was withheld. */
export function describeAutoResumeStop(reason: AutoResumeStopReason): string {
  return reason === "cut_off"
    ? "The reply was cut off. Send a message to continue."
    : "This reply reached its step limit. Send a message to continue.";
}

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
 * `lastStepHasPendingApproval`), never off an abandoned clarifying question
 * (see `lastStepDismissedAskUser`), and never past a cut-off response or a
 * spent step budget (see `autoResumeStopReason`).
 */
export function shouldAutoResumeTurn(options: AutoResumeInput): boolean {
  return decideAutoResume(options).resume;
}

/**
 * The same decision, plus what it held back: `heldBack` is set when the tool
 * branch would have resumed but the bound stopped it. One evaluation for
 * both, so a caller that needs the notice does not ask the SDK twice.
 */
export function decideAutoResume(options: AutoResumeInput): {
  resume: boolean;
  heldBack: AutoResumeStopReason | null;
} {
  if (lastStepHasPendingApproval(options)) {
    return { resume: false, heldBack: null };
  }
  if (lastStepDismissedAskUser(options)) {
    return { resume: false, heldBack: null };
  }
  if (lastAssistantMessageIsCompleteWithToolCalls(options)) {
    const heldBack = autoResumeStopReason(options);
    return { resume: heldBack === null, heldBack };
  }
  return {
    resume: lastAssistantMessageIsCompleteWithApprovalResponses(options),
    heldBack: null,
  };
}

/**
 * The notice for a turn `shouldAutoResumeTurn` would have resumed but held
 * back, or `null`. Stopping silently reads as the assistant giving up
 * mid-task; one line saying why, and what to do, is the whole fix.
 */
export function autoResumeStoppedNotice(
  options: AutoResumeInput,
): string | null {
  const { heldBack } = decideAutoResume(options);
  return heldBack ? describeAutoResumeStop(heldBack) : null;
}
