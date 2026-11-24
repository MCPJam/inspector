import { InvalidToolInputError, NoSuchToolError, type ModelMessage } from "ai";

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
  return messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type !== "tool-call" || !ids.has(part.toolCallId)) return part;
        const base = part.providerOptions;
        return { ...part, providerOptions: { ...base, mcpjam: { ...base?.mcpjam, rejectedToolCall: true } } };
      }),
    };
  });
}
