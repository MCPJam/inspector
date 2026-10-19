import { withoutSyntheticDenialResults } from "./harness-approval-messages.js";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { collectHarnessAgentToolApprovalContinuations } from "@ai-sdk/harness/agent";

/** Full UI history repeats approval responses even after the call has finished. */
export function pendingApprovalContinuations(messages: ModelMessage[]) {
  messages = withoutSyntheticDenialResults(messages);
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
