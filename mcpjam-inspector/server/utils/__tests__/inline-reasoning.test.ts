import { describe, expect, it } from "vitest";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

import { withInlineReasoningExtracted } from "../inline-reasoning";

/**
 * DeepSeek-R1 streams its scratch work inside `<think>` tags on the text
 * channel, so the Playground rendered the reasoning as the answer. BB-136.
 */
function modelStreaming(deltas: string[]) {
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

async function collect(model: ReturnType<typeof withInlineReasoningExtracted>) {
  const { stream } = await model.doStream({ prompt: [] });
  const parts: LanguageModelV3StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

const textOf = (parts: LanguageModelV3StreamPart[]) =>
  parts
    .filter((p) => p.type === "text-delta")
    .map((p) => p.delta)
    .join("");

const reasoningOf = (parts: LanguageModelV3StreamPart[]) =>
  parts
    .filter((p) => p.type === "reasoning-delta")
    .map((p) => p.delta)
    .join("");

describe("withInlineReasoningExtracted", () => {
  it("moves a <think> block off the text channel", async () => {
    const parts = await collect(
      withInlineReasoningExtracted(
        modelStreaming(["<think>", "2 plus 2.", "</think>", "It is 4."]),
      ),
    );

    expect(reasoningOf(parts)).toContain("2 plus 2.");
    expect(textOf(parts)).toBe("It is 4.");
  });

  it("leaves a response with no think block untouched", async () => {
    const parts = await collect(
      withInlineReasoningExtracted(modelStreaming(["It is ", "4."])),
    );

    expect(textOf(parts)).toBe("It is 4.");
    expect(parts.some((p) => p.type === "reasoning-delta")).toBe(false);
  });
});
