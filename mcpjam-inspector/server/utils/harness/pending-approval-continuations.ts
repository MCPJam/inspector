import type { ModelMessage } from "@ai-sdk/provider-utils";
import { collectHarnessAgentToolApprovalContinuations } from "@ai-sdk/harness/agent";

/** Full UI history repeats approval responses even after the call has finished. */
export function pendingApprovalContinuations(messages: ModelMessage[]) {
  // The SDK synthesizes an execution-denied result before the live runtime
  // receives the decision. It must still reach the parked permission request.
  const last = messages.at(-1);
  const pendingDenials = new Set<string>();
  const decisionMessages = messages.map((message) =>
    message === last && message.role === "tool"
      ? {
          ...message,
          content: message.content.filter((part) => {
            if (
              part.type !== "tool-result" ||
              part.output.type !== "execution-denied"
            )
              return true;
            pendingDenials.add(part.toolCallId);
            return false;
          }),
        }
      : message,
  );
  const completed = new Set<string>();
  const calls = new Map<string, string>();
  for (const message of decisionMessages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "tool-result") completed.add(part.toolCallId);
      if (part.type === "tool-approval-request") {
        calls.set(part.approvalId, part.toolCallId);
      }
    }
  }
  return collectHarnessAgentToolApprovalContinuations({
    messages: decisionMessages as never,
  }).filter((continuation) => {
    const callId = calls.get(continuation.approvalId);
    // Completed output-denied UI parts carry no result. Only a fresh denial
    // has the synthetic execution-denied marker emitted by the pinned SDK.
    return (
      callId === undefined ||
      (!completed.has(callId) &&
        (continuation.approved ||
          continuation.providerExecuted !== true ||
          pendingDenials.has(callId)))
    );
  });
}
