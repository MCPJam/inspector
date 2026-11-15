import { createAnthropic } from "@ai-sdk/anthropic";
import { tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  consumeDirectChatTurnHeadless,
  runDirectChatTurn,
} from "../direct-chat-turn.js";

type AnthropicBody = {
  tools?: Array<{ name: string }>;
  messages: Array<{ content: Array<{ type: string; name?: string }> }>;
};

/** Anthropic stub that calls `cart_add` on the first request and then stops. */
function capturingAnthropic() {
  const bodies: AnthropicBody[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const first = bodies.length === 1;
    const block = first
      ? { type: "tool_use", id: "call-1", name: "cart_add", input: {} }
      : { type: "text", text: "" };
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: block },
      {
        type: "content_block_delta",
        index: 0,
        delta: first
          ? { type: "input_json_delta", partial_json: "{}" }
          : { type: "text_delta", text: "Added." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: {
          stop_reason: first ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: 3 },
      },
      { type: "message_stop" },
    ];
    return new Response(
      events
        .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  return {
    bodies,
    model: createAnthropic({ apiKey: "test-only", fetch })("claude-haiku-4-5"),
  };
}

describe("direct turn with MCP tool names Anthropic rejects", () => {
  it("sends provider-safe aliases and runs the server's own tool", async () => {
    const { model, bodies } = capturingAnthropic();
    const execute = vi.fn(async () => ({ added: true }));
    const handle = runDirectChatTurn({
      llmModel: model,
      modelId: "claude-haiku-4-5",
      provider: "anthropic",
      messageHistory: [{ role: "user", content: "add it" }],
      systemPrompt: "",
      tools: {
        "cart.add": tool({ inputSchema: z.object({}), execute }),
      },
      maxRetries: 0,
    });
    const result = await consumeDirectChatTurnHeadless(handle);

    expect(bodies).toHaveLength(2);
    expect(bodies[0].tools?.map((t) => t.name)).toEqual(["cart_add"]);
    expect(
      bodies[1].messages.flatMap((m) => m.content).filter((p) => p.name),
    ).toEqual([expect.objectContaining({ name: "cart_add" })]);
    expect(execute).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.messages)).toContain('"toolName":"cart.add"');
    expect(JSON.stringify(result.messages)).not.toContain("cart_add");
  });
});
