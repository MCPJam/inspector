import { wrapLanguageModel, type ModelMessage } from "ai";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";

type Model = Parameters<typeof wrapLanguageModel>[0]["model"];

function createToolCallIdNormalizer(used: Set<string>, step: number) {
  const current = new Map<string, string>();
  return {
    reserve(id: string) {
      const existing = current.get(id);
      if (existing !== undefined) return existing;
      let unique = id;
      for (let suffix = 1; used.has(unique); suffix++) {
        unique = `${id}__s${step}_${suffix}`;
      }
      current.set(id, unique);
      used.add(unique);
      return unique;
    },
    resolve(id: string) {
      return current.get(id) ?? id;
    },
  };
}

function reserveToolCallIds(
  used: Set<string>,
  messages: readonly { content: unknown }[],
) {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as unknown[]) {
      if (part && typeof part === "object" && "toolCallId" in part &&
          typeof part.toolCallId === "string") {
        used.add(part.toolCallId);
      }
    }
  }
}

/** Keep the provider's first ID where possible and reserve prior prompt IDs. */
export function withUniqueToolCallIds(model: Model, history: readonly ModelMessage[] = []) {
  const used = new Set<string>();
  reserveToolCallIds(used, history);
  let step = 0;
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        reserveToolCallIds(used, params.prompt);
        const normalize = createToolCallIdNormalizer(used, ++step);
        const result = await doGenerate();
        for (const part of result.content) {
          if (part.type === "tool-call") normalize.reserve(part.toolCallId);
        }
        return {
          ...result,
          content: result.content.map((part) =>
            "toolCallId" in part
              ? { ...part, toolCallId: normalize.resolve(part.toolCallId) }
              : part
          ),
        };
      },
      wrapStream: async ({ doStream, params }) => {
        reserveToolCallIds(used, params.prompt);
        const normalize = createToolCallIdNormalizer(used, ++step);
        const result = await doStream();
        return {
          ...result,
          stream: result.stream.pipeThrough(new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
            transform(part, controller) {
              if ("toolCallId" in part) {
                const toolCallId = part.type === "tool-call"
                  ? normalize.reserve(part.toolCallId)
                  : normalize.resolve(part.toolCallId);
                controller.enqueue({ ...part, toolCallId });
              } else if (part.type === "tool-input-start") {
                controller.enqueue({ ...part, id: normalize.reserve(part.id) });
              } else if (part.type === "tool-input-delta" || part.type === "tool-input-end") {
                controller.enqueue({ ...part, id: normalize.resolve(part.id) });
              } else {
                controller.enqueue(part);
              }
            },
          })),
        };
      },
    },
  });
}
