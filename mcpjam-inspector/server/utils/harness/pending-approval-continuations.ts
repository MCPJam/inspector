import { withoutSyntheticDenialResults } from "./harness-approval-messages.js";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { collectHarnessAgentToolApprovalContinuations } from "@ai-sdk/harness/agent";

/** Full UI history repeats approval responses even after the call has finished. */
export function pendingApprovalContinuations(messages: ModelMessage[]) {
  // A fresh runtime (for example after a model change) can reuse call ids.
  // Only results from this user turn can settle its pending approvals.
  let turnStart = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") { turnStart = index; break; }
  }
  messages = withoutSyntheticDenialResults(messages.slice(turnStart));
  const completed = new Set<string>();
  const calls = new Map<string, string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-result") completed.add(part.toolCallId);
      if (part.type === "tool-approval-request") {
        calls.set(part.approvalId, part.toolCallId);
      }
    }
  }
  return collectHarnessAgentToolApprovalContinuations({
    messages,
  }).filter((continuation) => {
    const callId = calls.get(continuation.approvalId);
    return callId === undefined || !completed.has(callId);
  });
}
