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

/** A paused harness turn can span several persisted assistant segments. */
export function mergeHarnessApprovalSegments(transcript: unknown[]): unknown[] {
  const output: unknown[] = [];
  let segment: Array<Record<string, unknown>> = [];
  const flush = () => {
    const hasHarnessApproval = segment.some((message) =>
      Array.isArray(message.content) && message.content.some((part: unknown) =>
        isRecord(part) && part.type === "tool-call" &&
        part.providerExecuted === true && isRecord(part.approval),
      ),
    );
    if (hasHarnessApproval && segment.length > 1) {
      // useChat applies continuation results to the last assistant message.
      // Keep all calls from that user turn there, including earlier native calls
      // whose buffered results arrive after a later MCP approval.
      output.push({ ...segment[0], content: segment.flatMap((message) =>
        Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }],
      ) });
    } else output.push(...segment);
    segment = [];
  };
  for (const message of transcript) {
    if (isRecord(message) && message.role === "assistant") segment.push(message);
    else {
      flush();
      output.push(message);
    }
  }
  flush();
  return output;
}
