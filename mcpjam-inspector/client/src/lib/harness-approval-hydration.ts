import { isToolUIPart, type UIMessage } from "ai";

/** Safe projection of the runtime's current pending approvals. */
export interface PendingHarnessApproval {
  approvalId: string;
  toolCallId: string;
  providerExecuted?: boolean;
}

export function hydrateHarnessApprovals(
  messages: UIMessage[],
  pending: readonly PendingHarnessApproval[] = [],
): UIMessage[] {
  if (pending.length === 0) return messages;
  const byCall = new Map(
    pending.map((approval) => [approval.toolCallId, approval]),
  );
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) => {
      if (!isToolUIPart(part) || part.state !== "input-available") return part;
      const approval = byCall.get(part.toolCallId);
      if (!approval) return part;
      return {
        ...part,
        state: "approval-requested" as const,
        approval: { id: approval.approvalId },
        ...(approval.providerExecuted === undefined
          ? {}
          : { providerExecuted: approval.providerExecuted }),
      };
    }),
  }));
}
