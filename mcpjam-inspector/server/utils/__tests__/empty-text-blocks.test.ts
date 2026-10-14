import { createAnthropic } from "@ai-sdk/anthropic";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { mcpCallToolResultToModelOutput } from "@mcpjam/sdk";
import { generateText, stepCountIs, tool, type ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { withoutEmptyTextBlocks } from "../empty-text-blocks.js";
import {
  runDirectChatTurn,
  consumeDirectChatTurnHeadless,
} from "../direct-chat-turn.js";

const output = () =>
  mcpCallToolResultToModelOutput({
    content: [
      { type: "text", text: "" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ],
  })!;
const screenshot = tool({
  inputSchema: z.object({}),
  execute: async () => ({}),
  toModelOutput: output,
});
const history: ModelMessage[] = [
  { role: "user", content: "take a screenshot" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "shot-1",
        toolName: "screenshot",
        input: {},
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "shot-1",
        toolName: "screenshot",
        output: output(),
      },
    ],
  },
];

function capturingAnthropic() {
  const bodies: Array<{
    messages: Array<{ role: string; content: unknown[] }>;
  }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const first = bodies.length === 1;
    const content = first
      ? [{ type: "tool_use", id: "shot-1", name: "screenshot", input: {} }]
      : [{ type: "text", text: "Done." }];
    if (!body.stream)
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content,
        stop_reason: first ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 3 },
      });
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
      {
        type: "content_block_start",
        index: 0,
        content_block: first ? content[0] : { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: first
          ? { type: "input_json_delta", partial_json: "{}" }
          : { type: "text_delta", text: "Done." },
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

function toolContent(
  body: ReturnType<typeof capturingAnthropic>["bodies"][number],
) {
  const toolResult = body.messages
    .flatMap((m) => m.content)
    .find(
      (p) =>
        p && typeof p === "object" && "type" in p && p.type === "tool_result",
    );
  expect(toolResult).toBeDefined();
  return toolResult as { type: string; content: unknown[] };
}

describe("provider-scoped empty text requests", () => {
  it("reproduces the unwrapped model's empty tool text on step 2", async () => {
    const { model, bodies } = capturingAnthropic();
    await generateText({
      model,
      prompt: "take a screenshot",
      tools: { screenshot },
      stopWhen: stepCountIs(2),
      maxRetries: 0,
    });
    expect(toolContent(bodies[1]).content).toContainEqual({
      type: "text",
      text: "",
    });
  });

  it("cleans tool output generated mid-turn before every Anthropic request", async () => {
    const { model, bodies } = capturingAnthropic();
    const result = await generateText({
      model: withoutEmptyTextBlocks(model),
      prompt: "take a screenshot",
      tools: { screenshot },
      stopWhen: stepCountIs(2),
      maxRetries: 0,
    });
    expect(bodies).toHaveLength(2);
    expect(toolContent(bodies[1]).content).not.toContainEqual({
      type: "text",
      text: "",
    });
    expect(toolContent(bodies[1]).content).toContainEqual(
      expect.objectContaining({ type: "image" }),
    );
    expect(result.responseMessages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        content: [
          expect.objectContaining({
            output: expect.objectContaining({
              value: expect.arrayContaining([{ type: "text", text: "" }]),
            }),
          }),
        ],
      }),
    );
  });

  it("wires cleanup into the real direct streaming driver without changing persisted history", async () => {
    const { model, bodies } = capturingAnthropic();
    const messageHistory: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "\n" },
      { role: "user", content: "take a screenshot" },
    ];
    const before = structuredClone(messageHistory);
    const onPersist = vi.fn();
    const handle = runDirectChatTurn({
      llmModel: model,
      modelId: "claude-haiku-4-5",
      provider: "anthropic",
      messageHistory,
      systemPrompt: "",
      tools: { screenshot },
      maxRetries: 0,
      onPersist,
    });
    const result = await consumeDirectChatTurnHeadless(handle);
    expect(bodies).toHaveLength(2);
    expect(result.steps).toHaveLength(2);
    expect(toolContent(bodies[1]).content).not.toContainEqual({
      type: "text",
      text: "",
    });
    expect(messageHistory).toEqual(before);
    expect(onPersist).toHaveBeenCalledOnce();
    expect(result.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        content: [
          expect.objectContaining({
            output: expect.objectContaining({
              value: expect.arrayContaining([{ type: "text", text: "" }]),
            }),
          }),
        ],
      }),
    );
  });

  it("removes whitespace-only assistant history and prefills", async () => {
    const { model, bodies } = capturingAnthropic();
    await generateText({
      model: withoutEmptyTextBlocks(model),
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "\n" },
        { role: "user", content: "list skills" },
        { role: "assistant", content: " \n " },
      ],
      maxRetries: 0,
    });
    expect(bodies[0].messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "list skills" },
        ],
      },
    ]);
  });

  it("keeps Gemini 2.x's functionResponse for an empty caption plus image", async () => {
    const bodies: Array<{
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Done." }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 3,
          totalTokenCount: 13,
        },
      });
    });
    const model = createGoogle({ apiKey: "test-only", fetch })(
      "gemini-2.5-flash",
    );
    expect(withoutEmptyTextBlocks(model)).toBe(model);
    await generateText({
      model: withoutEmptyTextBlocks(model),
      messages: history,
      maxRetries: 0,
    });
    expect(
      bodies[0].contents
        .flatMap((m) => m.parts)
        .filter((p) => p.functionResponse),
    ).toHaveLength(1);
    expect(
      bodies[0].contents.flatMap((m) => m.parts).some((p) => p.inlineData),
    ).toBe(true);
  });

  it("keeps strict user/assistant alternation on an OpenAI-compatible model", async () => {
    const bodies: Array<{
      messages: Array<{ role: string; content: unknown }>;
    }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: "chat-1",
        object: "chat.completion",
        created: 1,
        model: "gemma3",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Done." },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      });
    });
    const model = createOpenAI({
      apiKey: "test-only",
      baseURL: "https://ollama.test/v1",
      fetch,
    }).chat("gemma3");
    expect(withoutEmptyTextBlocks(model)).toBe(model);
    await generateText({
      model: withoutEmptyTextBlocks(model),
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "" },
        { role: "user", content: "continue" },
      ],
      maxRetries: 0,
    });
    expect(bodies[0].messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(bodies[0].messages[1].content).toBe("");
  });

  it("cleans Bedrock's text blocks without dropping tool calls or images", async () => {
    const bodies: Array<{ messages: unknown[] }> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        output: {
          message: { role: "assistant", content: [{ text: "Done." }] },
        },
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
        metrics: { latencyMs: 1 },
      });
    });
    const model = createAmazonBedrock({
      region: "us-east-1",
      accessKeyId: "test-only",
      secretAccessKey: "test-only",
      fetch,
    })("anthropic.claude-haiku-4-5");
    await generateText({
      model: withoutEmptyTextBlocks(model),
      messages: history,
      tools: { screenshot },
      maxRetries: 0,
    });
    expect(JSON.stringify(bodies[0].messages)).not.toContain('"text":""');
    expect(JSON.stringify(bodies[0].messages)).toContain('"toolResult"');
    expect(JSON.stringify(bodies[0].messages)).toContain('"image"');
  });
});
