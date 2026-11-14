import type { EvalTraceSpan } from "@/shared/eval-trace";

/** Combined chat history can merge assistant segments between requests. */
export function projectChatTraceRanges(
  spans: readonly EvalTraceSpan[],
  messages: readonly { role: string; content?: unknown }[],
): { spans: EvalTraceSpan[]; userIndices: number[] } {
  const userIndices: number[] = [];
  const toolIndices = new Map<string, number[]>();
  messages.forEach((message, index) => {
    if (message.role === "user") userIndices.push(index);
    if (!Array.isArray(message.content)) return;
    for (const part of message.content) {
      if (
        typeof part !== "object" || part === null ||
        (part.type !== "tool-call" && part.type !== "tool-result") ||
        typeof part.toolCallId !== "string"
      ) continue;
      const indices = toolIndices.get(part.toolCallId) ?? [];
      indices.push(index);
      toolIndices.set(part.toolCallId, indices);
    }
  });
  return {
    userIndices,
    spans: spans.map((span) => {
      const start = userIndices[span.promptIndex ?? 0];
      const end = userIndices[(span.promptIndex ?? 0) + 1] ?? messages.length;
      const indices = start !== undefined && span.category === "tool" && span.toolCallId
        ? toolIndices.get(span.toolCallId)?.filter((index) => index >= start && index < end) : undefined;
      // Original LLM segment boundaries cannot be recovered from merged UI
      // messages. Only a tool's stable call ID proves its message association.
      return {
        ...span,
        messageStartIndex: indices?.[0],
        messageEndIndex: indices?.at(-1),
      };
    }),
  };
}
