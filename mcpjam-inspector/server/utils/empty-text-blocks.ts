import { wrapLanguageModel, type LanguageModel } from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";

/** Clean each rejecting provider's request, including tool results added mid-turn.
 * Other providers and saved history retain their original message structure. */
export function withoutEmptyTextBlocks(model: LanguageModel): LanguageModel {
  if (typeof model === "string" || !rejectsEmptyText(model.provider))
    return model;
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        prompt: dropEmptyTextBlocks(params.prompt),
      }),
    },
  });
}

/** Hosted calls have no local model object; sanitize their per-step copy only. */
export function hostedMessagesWithoutEmptyText(
  messages: ModelMessage[],
  modelId: string,
  provider?: string,
): ModelMessage[] {
  return rejectsEmptyText(provider ?? "") ||
    /^(anthropic\/|bedrock\/|claude-)/.test(modelId)
    ? dropEmptyTextBlocks(messages)
    : messages;
}

function rejectsEmptyText(provider: string): boolean {
  return /^(anthropic|amazon-bedrock|bedrock)(\.|$)/.test(provider);
}

export function dropEmptyTextBlocks<
  T extends { role: string; content: unknown },
>(messages: T[]): T[] {
  return messages.flatMap((message): T[] => {
    // Empty system text may carry provider-level effort or tool-change controls.
    if (message.role === "system") return [message];
    if (typeof message.content === "string")
      return message.content.trim() === "" ? [] : [message];
    if (!Array.isArray(message.content)) return [message];
    if (message.role === "tool") {
      const original = message.content;
      const content = original.map(dropEmptyToolText);
      return content.every((part, index) => part === original[index])
        ? [message]
        : [{ ...message, content }];
    }
    const content = message.content.filter((part) => !isEmptyTextPart(part));
    if (content.length === message.content.length) return [message];
    return content.length === 0 ? [] : [{ ...message, content }];
  });
}

function dropEmptyToolText(part: unknown): unknown {
  if (!part || typeof part !== "object" || !("output" in part)) return part;
  const output = part.output;
  if (
    !output ||
    typeof output !== "object" ||
    !("type" in output) ||
    output.type !== "content" ||
    !("value" in output) ||
    !Array.isArray(output.value)
  )
    return part;
  const value = output.value.filter((item) => !isEmptyTextPart(item));
  return value.length === output.value.length
    ? part
    : { ...part, output: { ...output, value } };
}

function isEmptyTextPart(part: unknown): boolean {
  return (
    !!part &&
    typeof part === "object" &&
    "type" in part &&
    part.type === "text" &&
    "text" in part &&
    typeof part.text === "string" &&
    part.text.trim() === ""
  );
}
