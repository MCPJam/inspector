import type { ModelMessage } from "@ai-sdk/provider-utils";

/** Anthropic rejects empty text blocks, including placeholders in chat history. */
export function dropEmptyModelText(messages: ModelMessage[]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (typeof message.content === "string") {
      return message.content === "" ? [] : [message];
    }
    if (!Array.isArray(message.content)) return [message];
    if (message.role === "user") {
      const content = message.content.filter(hasTextContent);
      if (content.length === 0) return [];
      return content.length === message.content.length
        ? [message]
        : [{ ...message, content }];
    }
    if (message.role === "assistant") {
      const content = message.content.filter(hasTextContent);
      if (content.length === 0) return [];
      return content.length === message.content.length
        ? [message]
        : [{ ...message, content }];
    }
    if (message.role === "tool") {
      const content = message.content.map((part) => {
        if (
          part.type !== "tool-result" ||
          part.output?.type !== "content" ||
          !Array.isArray(part.output.value)
        )
          return part;
        const value = part.output.value.filter(hasTextContent);
        return value.length === part.output.value.length
          ? part
          : { ...part, output: { ...part.output, value } };
      });
      return content.every((part, index) => part === message.content[index])
        ? [message]
        : [{ ...message, content }];
    }
    return [message];
  });
}

function hasTextContent(part: unknown): boolean {
  return !(
    part &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    part.text === ""
  );
}
