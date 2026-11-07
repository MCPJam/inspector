import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonSchema, tool, type ModelMessage, type UIMessageChunk } from "ai";
import { MCPClientManager } from "@mcpjam/sdk";
import { handleMCPJamFreeChatModel } from "../mcpjam-stream-handler";
import {
  __resetHostedModelCatalogForTests,
  __setHostedCatalogForTests,
} from "../../services/hosted-model-catalog.js";
import {
  CONTEXT_COMPACTION_PART,
  estimateModelTokens,
} from "@/shared/model-context-budget";

/**
 * PLB-300: the hosted engine bounds what it sends to `/stream`. An oversized
 * tool result reaches the model as its start and end around a marker, once,
 * and the chat is told so through one data part per turn.
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

const MODEL = "anthropic/claude-haiku-4.5";
const BASE64 = "QUJD".repeat(170_000);

function sseResponse(): Response {
  const events = [
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "Here are the terms." },
    { type: "text-end", id: "t" },
    {
      type: "finish",
      finishReason: "stop",
      totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ];
  return new Response(
    `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}

const toolResult = {
  type: "tool-result",
  toolCallId: "c1",
  toolName: "download_quote_document",
  output: {
    type: "json",
    value: {
      content: [{ type: "text", text: `{"contentBase64":"${BASE64}"}` }],
    },
  },
  result: {
    content: [{ type: "text", text: `{"contentBase64":"${BASE64}"}` }],
  },
};

const history: ModelMessage[] = [
  { role: "user", content: "Download the quote and show me the terms" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "download_quote_document",
        input: { documentUUID: "doc-1" },
      },
    ],
  },
  { role: "tool", content: [toolResult as never] },
];

async function runTurn(): Promise<{ body: any; messages: any[] }> {
  global.fetch = vi.fn().mockResolvedValue(sseResponse());
  await handleMCPJamFreeChatModel({
    messages: structuredClone(history),
    modelId: MODEL,
    systemPrompt: "You are helpful",
    tools: {
      download_quote_document: tool({
        description: "Downloads a quote document",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({}),
      }),
    },
    mcpClientManager: new MCPClientManager({}),
  });
  await lastExecution;
  const body = JSON.parse(
    String(vi.mocked(global.fetch).mock.calls[0]![1]!.body),
  );
  return { body, messages: JSON.parse(body.messages) };
}

function sentToolResult(messages: any[]): any {
  return messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content)
    .find((part: any) => part.toolCallId === "c1");
}

describe("mcpjam-stream-handler context budget", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    lastExecution = null;
    writtenChunks = [];
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    __setHostedCatalogForTests([MODEL], { [MODEL]: 200_000 });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
    __resetHostedModelCatalogForTests();
  });

  it("sends the start and end of an oversized tool result, not the whole payload", async () => {
    const { messages } = await runTurn();
    const sent = sentToolResult(messages);
    const text = JSON.stringify(sent.output);
    expect(text).toContain("[MCPJam cut ");
    expect(text.length).toBeLessThan(200_000);
    expect(estimateModelTokens(sent.output.value)).toBeLessThan(25_000);
  });

  it("tells the chat once per turn what the model got", async () => {
    await runTurn();
    const parts = writtenChunks.filter(
      (chunk) => chunk.type === CONTEXT_COMPACTION_PART,
    );
    expect(parts.length).toBeGreaterThan(0);
    const ids = new Set(parts.map((part: any) => part.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^context-compaction-/);
    expect((parts.at(-1) as any).data.shortened).toEqual([
      expect.objectContaining({
        toolCallId: "c1",
        toolName: "download_quote_document",
      }),
    ]);
  });
});
