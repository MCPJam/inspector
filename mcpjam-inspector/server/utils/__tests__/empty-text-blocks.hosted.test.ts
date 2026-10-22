import { MCPClientManager, mcpCallToolResultToModelOutput } from "@mcpjam/sdk";
import { tool, type ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runChatEngineLoop } from "../mcpjam-stream-handler.js";

// These tests exercise the hosted engine, which does not invoke a harness.
vi.mock("../harness/run-harness-turn", () => ({ runHarnessTurn: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function sse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

const screenshot = tool({
  inputSchema: z.object({}),
  execute: async () => ({}),
  toModelOutput: () =>
    mcpCallToolResultToModelOutput({
      content: [
        { type: "text", text: "" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ],
    })!,
});

function captureHostedRequests() {
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  const requests: Array<{ messages: ModelMessage[] }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ messages: JSON.parse(body.messages) });
      return sse([
        ...(requests.length === 1
          ? [
              {
                type: "tool-input-available",
                toolCallId: "shot-1",
                toolName: "screenshot",
                input: {},
              },
            ]
          : [
              { type: "text-start", id: "answer" },
              { type: "text-delta", id: "answer", delta: "Done." },
              { type: "text-end", id: "answer" },
            ]),
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]);
    }),
  );
  return requests;
}

describe("hosted empty text request boundary", () => {
  it.each([
    ["anthropic/claude-haiku-4.5", "anthropic", true],
    ["native-claude", "bedrock", true],
    ["google/gemini-2.5-flash", "google", false],
  ] as const)(
    "cleans each %s step and keeps saved history",
    async (modelId, provider, cleans) => {
      const requests = captureHostedRequests();
      const messages: ModelMessage[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "\n" },
        { role: "user", content: "take a screenshot" },
      ];
      const before = structuredClone(messages);
      const onConversationComplete = vi.fn();
      const result = await runChatEngineLoop(
        {
          messages,
          modelId,
          provider,
          systemPrompt: "",
          tools: { screenshot },
          mcpClientManager: new MCPClientManager(),
          onConversationComplete,
        },
        "none",
      );
      expect(requests).toHaveLength(2);
      expect(requests[0].messages.some((m) => m.role === "assistant")).toBe(
        !cleans,
      );
      const toolMessage = requests[1].messages.find((m) => m.role === "tool");
      expect(toolMessage).toMatchObject({
        content: [
          expect.objectContaining({
            toolCallId: "shot-1",
            output: {
              type: "content",
              value: cleans
                ? [
                    expect.objectContaining({
                      type: "file",
                      mediaType: "image/png",
                    }),
                  ]
                : [
                    { type: "text", text: "" },
                    expect.objectContaining({
                      type: "file",
                      mediaType: "image/png",
                    }),
                  ],
            },
          }),
        ],
      });
      expect(messages).toEqual(before);
      expect(result.messageHistory.slice(0, 3)).toEqual(before);
      expect(result.messageHistory).toContainEqual(
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
      expect(onConversationComplete).toHaveBeenCalledOnce();
      expect(onConversationComplete.mock.calls[0][0]).toEqual(
        result.messageHistory,
      );
    },
  );
});
