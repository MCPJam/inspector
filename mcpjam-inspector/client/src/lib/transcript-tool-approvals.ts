function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Fold model-message approval parts into their tool call before hydration. */
export function mergeTranscriptApprovals(transcript: unknown[]): unknown[] {
  const calls = new Map<string, Record<string, unknown>>();
  const approvals = new Map<string, Record<string, unknown>>();
  return transcript.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return message;
    const seen = new Set<string>();
    const content: unknown[] = [];
    for (const original of message.content) {
      if (!isRecord(original)) {
        content.push(original);
        continue;
      }
      const part = { ...original };
      if (part.type === "tool-call" && typeof part.toolCallId === "string") {
        if (seen.has(part.toolCallId)) continue;
        seen.add(part.toolCallId);
        calls.set(part.toolCallId, part);
      } else if (
        part.type === "tool-approval-request" &&
        typeof part.approvalId === "string" &&
        typeof part.toolCallId === "string"
      ) {
        const call = calls.get(part.toolCallId);
        if (call) {
          call.approval = { id: part.approvalId };
          approvals.set(part.approvalId, call);
        }
        continue;
      } else if (
        part.type === "tool-approval-response" &&
        typeof part.approvalId === "string" &&
        typeof part.approved === "boolean"
      ) {
        const call = approvals.get(part.approvalId);
        if (call) {
          call.approval = {
            id: part.approvalId,
            approved: part.approved,
            ...(typeof part.reason === "string" ? { reason: part.reason } : {}),
          };
        }
        continue;
      }
      content.push(part);
    }
    return { ...message, content };
  });
}

export function readTranscriptApproval(part: Record<string, unknown>, resolved: boolean) {
  const approval = part.approval;
  if (!isRecord(approval) || typeof approval.id !== "string") return {};
  if (approval.approved === false) {
    return { state: "output-denied" as const, approval };
  }
  if (resolved) return { approval };
  return {
    state: typeof approval.approved === "boolean"
      ? "approval-responded" as const
      : "approval-requested" as const,
    approval,
  };
}
