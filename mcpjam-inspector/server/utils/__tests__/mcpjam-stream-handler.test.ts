import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMCPJamFreeChatModel } from "../mcpjam-stream-handler";

let lastExecution: Promise<void> | null = null;

const buildSsePayload = (events: any[]) =>
  `${events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;

const createSseResponse = (events: any[]) => {
  const encoder = new TextEncoder();
  const payload = buildSsePayload(events);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    createUIMessageStream: vi.fn(({ execute, onFinish }) => {
      const writer = { write: vi.fn() };
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

vi.mock("@/shared/http-tool-calls", () => ({
  hasUnresolvedToolCalls: vi.fn().mockReturnValue(false),
  executeToolCallsFromMessages: vi.fn(),
}));

vi.mock("../chat-helpers", () => ({
  scrubMcpAppsToolResultsForBackend: vi.fn((messages) => messages),
  scrubChatGPTAppsToolResultsForBackend: vi.fn((messages) => messages),
}));

vi.mock("../mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

describe("mcpjam-stream-handler", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    lastExecution = null;
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse([
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]),
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  it("scrubs backend-only approval parts while preserving full history for completion callbacks", async () => {
    const onConversationComplete = vi.fn();
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "search",
            input: { q: "hello" },
          },
          {
            type: "tool-approval-request",
            approvalId: "approval-1",
            toolCallId: "call-1",
          },
        ],
      },
    ] as any;

    await handleMCPJamFreeChatModel({
      messages,
      modelId: "gpt-4.1-mini",
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as any,
      onConversationComplete,
    });

    await lastExecution;

    const fetchBody = JSON.parse(
      ((global.fetch as any).mock.calls[0]?.[1]?.body as string) ?? "{}",
    );
    const scrubbedMessages = JSON.parse(fetchBody.messages);

    expect(scrubbedMessages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "search",
            input: { q: "hello" },
          },
        ],
      },
    ]);
    expect(onConversationComplete).toHaveBeenCalledWith(messages);
  });

  it("preserves spliced denial tool results in the completed conversation history", async () => {
    const onConversationComplete = vi.fn();

    await handleMCPJamFreeChatModel({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "search",
              input: { q: "hello" },
            },
            {
              type: "tool-approval-request",
              approvalId: "approval-1",
              toolCallId: "call-1",
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-approval-response",
              approvalId: "approval-1",
              approved: false,
            },
          ],
        },
      ] as any,
      modelId: "gpt-4.1-mini",
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as any,
      requireToolApproval: true,
      onConversationComplete,
    });

    await lastExecution;

    const fullHistory = onConversationComplete.mock.calls[0]?.[0];
    expect(fullHistory).toHaveLength(3);
    expect(fullHistory[1]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "search",
          output: {
            type: "error-text",
            value: "Tool execution denied by user.",
          },
        },
      ],
    });
    expect(fullHistory[2]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-approval-response",
          approvalId: "approval-1",
          approved: false,
        },
      ],
    });
  });
});
