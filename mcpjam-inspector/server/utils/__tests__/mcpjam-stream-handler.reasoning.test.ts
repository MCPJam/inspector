import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage, UIMessageChunk } from "ai";
import { MCPClientManager } from "@mcpjam/sdk";
import { handleMCPJamFreeChatModel } from "../mcpjam-stream-handler";

/**
 * Reasoning on the live path: what the backend streams must reach the client
 * stream, and an empty reasoning block must not become a persisted part.
 */

let lastExecution: Promise<void> | null = null;
let writtenChunks: UIMessageChunk[] = [];

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    createUIMessageStream: vi.fn(({ execute, onFinish }) => {
      const writer = {
        write: vi.fn((chunk: UIMessageChunk) => {
          writtenChunks.push(chunk);
        }),
      };
      lastExecution = Promise.resolve(execute({ writer })).then(async () => {
        await onFinish?.();
      });
      return { getReader: vi.fn() };
    }),
    createUIMessageStreamResponse: vi.fn().mockReturnValue(
      new Response("{}", {
        headers: { "Content-Type": "text/event-stream" },
      }),
    ),
  };
});

// Loads `@ai-sdk/harness/agent`, an optional package; no harness turn runs here.
vi.mock("../harness/run-harness-turn", () => ({ runHarnessTurn: vi.fn() }));

function sseResponse(events: object[]): Response {
  const payload = `${events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

const answer = [
  { type: "text-start", id: "text-1" },
  { type: "text-delta", id: "text-1", delta: "Here they are:" },
  { type: "text-end", id: "text-1" },
  {
    type: "finish",
    finishReason: "stop",
    totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  },
];

const messages: ModelMessage[] = [{ role: "user", content: "List my servers" }];

async function runTurn(
  events: object[],
  onConversationComplete = vi.fn(),
): Promise<void> {
  global.fetch = vi.fn().mockResolvedValue(sseResponse(events));
  await handleMCPJamFreeChatModel({
    messages,
    modelId: "openai/gpt-5-nano",
    systemPrompt: "You are helpful",
    tools: {},
    mcpClientManager: new MCPClientManager({}),
    onConversationComplete,
  });
  await lastExecution;
}

const isReasoning = (chunk: UIMessageChunk) =>
  chunk.type.startsWith("reasoning");

describe("mcpjam-stream-handler reasoning", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    lastExecution = null;
    writtenChunks = [];
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  it("forwards reasoning chunks to the client stream before the answer", async () => {
    const reasoning = [
      { type: "reasoning-start", id: "reasoning-1" },
      {
        type: "reasoning-delta",
        id: "reasoning-1",
        delta: "The user wants the server list.",
      },
      { type: "reasoning-end", id: "reasoning-1" },
    ];
    await runTurn([...reasoning, ...answer]);

    expect(writtenChunks.filter(isReasoning)).toEqual(reasoning);
    // The LAST reasoning chunk precedes the answer: a reasoning-end leaking
    // out after text-start would render the summary below what it explains.
    const lastReasoning = writtenChunks.map(isReasoning).lastIndexOf(true);
    const firstText = writtenChunks.findIndex(
      (chunk) => chunk.type === "text-start",
    );
    expect(lastReasoning).toBeGreaterThanOrEqual(0);
    expect(lastReasoning).toBeLessThan(firstText);
  });

  it("persists no reasoning part when the block carries no text", async () => {
    // A reasoning model that was not asked for a summary streams exactly
    // this. An empty part would render as a "Reasoning" header with nothing
    // under it.
    const onConversationComplete = vi.fn();
    await runTurn(
      [
        { type: "reasoning-start", id: "reasoning-1" },
        { type: "reasoning-delta", id: "reasoning-1", delta: "" },
        { type: "reasoning-end", id: "reasoning-1" },
        ...answer,
      ],
      onConversationComplete,
    );

    const history: ModelMessage[] = onConversationComplete.mock.calls[0]?.[0];
    expect(history[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Here they are:" }],
    });
  });
});
