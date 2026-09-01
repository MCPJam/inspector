/**
 * Shared fixture for the BB-136 `<think>` extraction tests. A model that
 * inlines its scratch work on the text channel (DeepSeek-R1 does) plus the
 * readers needed to tell an extracted reasoning channel from the answer.
 */
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";

/** A v3 model whose text channel carries `deltas` verbatim. */
export function thinkStreamModel(deltas: string[]) {
  const chunks: LanguageModelV3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "0" },
    ...deltas.map((delta) => ({ type: "text-delta" as const, id: "0", delta })),
    { type: "text-end", id: "0" },
    {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ];
  return new MockLanguageModelV3({
    doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
  });
}

/** The canonical `<think>` case: reasoning inlined ahead of the answer. */
export const THINK_DELTAS = ["<think>", "2 plus 2.", "</think>", "It is 4."];

export async function collectStreamParts(model: LanguageModelV3) {
  const { stream } = await model.doStream({ prompt: [] });
  const parts: LanguageModelV3StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

export const textOf = (parts: LanguageModelV3StreamPart[]) =>
  parts
    .filter((p) => p.type === "text-delta")
    .map((p) => p.delta)
    .join("");

export const reasoningOf = (parts: LanguageModelV3StreamPart[]) =>
  parts
    .filter((p) => p.type === "reasoning-delta")
    .map((p) => p.delta)
    .join("");
