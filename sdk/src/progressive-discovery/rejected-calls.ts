import { InvalidToolInputError, NoSuchToolError, type ModelMessage, type ToolCallPart, type ToolResultPart } from "ai";

export function collectRejectedToolCalls(
  ids: Set<string>,
  calls: readonly { toolCallId: string; invalid?: boolean; error?: unknown }[],
) {
  for (const call of calls) {
    if (call.invalid && (NoSuchToolError.isInstance(call.error) || InvalidToolInputError.isInstance(call.error))) {
      ids.add(call.toolCallId);
    }
  }
}

export function markRejectedCalls(messages: ModelMessage[], ids: ReadonlySet<string>): ModelMessage[] {
  if (!ids.size) return messages;
  const mark = <Part extends ToolCallPart | ToolResultPart>(part: Part): Part => {
    if (!ids.has(part.toolCallId)) return part;
    const base = part.providerOptions;
    return { ...part, providerOptions: { ...base, mcpjam: { ...base?.mcpjam, rejectedToolCall: true } } };
  };

  return messages.map((message) => {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map((part) => part.type === "tool-call" ? mark(part) : part),
      };
    }
    if (message.role === "tool") {
      return {
        ...message,
        content: message.content.map((part) => part.type === "tool-result" ? mark(part) : part),
      };
    }
    return message;
  });
}
