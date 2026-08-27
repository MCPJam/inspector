import { afterEach, describe, expect, it, vi } from "vitest";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

import { createLlmModel } from "../chat-helpers";

/**
 * The wiring half of BB-136: every model `createLlmModel` hands out has to
 * extract an inline `<think>` block, not just the wrapper in isolation.
 */
function sseResponse(deltas: string[]) {
  const lines = deltas.map(
    (content) =>
      `data: ${JSON.stringify({
        id: "1",
        object: "chat.completion.chunk",
        created: 1,
        model: "test",
        choices: [{ index: 0, delta: { role: "assistant", content } }],
      })}\n\n`,
  );
  lines.push("data: [DONE]\n\n");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createLlmModel", () => {
  it("extracts an inline <think> block off the text channel", async () => {
    vi.stubGlobal("fetch", async () =>
      sseResponse(["<think>", "2 plus 2.", "</think>", "It is 4."]),
    );

    const model = createLlmModel(
      { id: "deepseek-reasoner", name: "test", provider: "deepseek" },
      "test-key",
    );
    const { stream } = await model.doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "2+2?" }] }],
    });

    const parts: LanguageModelV3StreamPart[] = [];
    for await (const part of stream) parts.push(part);
    const joined = (type: string) =>
      parts
        .filter((p) => p.type === type)
        .map((p) => (p as { delta: string }).delta)
        .join("");

    expect(joined("reasoning-delta")).toContain("2 plus 2.");
    expect(joined("text-delta")).toBe("It is 4.");
  });
});
