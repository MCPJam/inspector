import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import { handleMCPJamFreeChatModel } from "../mcpjam-stream-handler";
import { createHostedRpcLogCollector } from "../../routes/web/hosted-rpc-logs.js";

let lastExecution: Promise<void> | null = null;
let writtenChunks: any[] = [];

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
      const writer = {
        write: vi.fn((chunk) => {
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

vi.mock("@/shared/http-tool-calls", () => ({
  hasUnresolvedToolCalls: vi.fn().mockReturnValue(false),
  executeToolCallsFromMessages: vi.fn(),
}));

vi.mock("../chat-helpers", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-helpers")>("../chat-helpers");
  return {
    ...actual,
    scrubMcpAppsToolResultsForBackend: vi.fn((messages) => messages),
    scrubChatGPTAppsToolResultsForBackend: vi.fn((messages) => messages),
  };
});

vi.mock("../mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

vi.mock("../logger", () => ({
  logger: {
    error: vi.fn(),
  },
}));

describe("mcpjam-stream-handler", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    lastExecution = null;
    writtenChunks = [];
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);
    vi.mocked(executeToolCallsFromMessages).mockResolvedValue([]);
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
      tools: {
        search: {
          description: "Search the web",
          inputSchema: {} as any,
        },
      },
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
    expect(onConversationComplete).toHaveBeenCalledWith(
      messages,
      expect.objectContaining({
        turnId: expect.any(String),
        promptIndex: expect.any(Number),
        startedAt: expect.any(Number),
        endedAt: expect.any(Number),
        spans: expect.any(Array),
        modelId: expect.any(String),
      }),
    );
  });

  it("removes stale disconnected tool history before sending the next turn to Convex", async () => {
    await handleMCPJamFreeChatModel({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "create_view",
              input: { elements: [] },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "create_view",
              output: {
                type: "json",
                value: { ok: true },
              },
            },
          ],
        },
        {
          role: "user",
          content: "Draw a dog",
        },
      ] as any,
      modelId: "gpt-4.1-mini",
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as any,
    });

    await lastExecution;

    const fetchBody = JSON.parse(
      ((global.fetch as any).mock.calls[0]?.[1]?.body as string) ?? "{}",
    );
    const scrubbedMessages = JSON.parse(fetchBody.messages);

    expect(scrubbedMessages).toEqual([
      {
        role: "user",
        content: "Draw a dog",
      },
    ]);
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

  it("runs teardown even when conversation persistence fails", async () => {
    const onConversationComplete = vi
      .fn()
      .mockRejectedValue(new Error("persist failed"));
    const onStreamComplete = vi.fn();

    await handleMCPJamFreeChatModel({
      messages: [] as any,
      modelId: "gpt-4.1-mini",
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as any,
      onConversationComplete,
      onStreamComplete,
    });

    await lastExecution;

    expect(onConversationComplete).toHaveBeenCalledTimes(1);
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
    expect(onStreamComplete.mock.invocationCallOrder[0]).toBeGreaterThan(
      onConversationComplete.mock.invocationCallOrder[0],
    );
  });

  it("skips conversation persistence after stream errors but still runs teardown", async () => {
    const onConversationComplete = vi.fn();
    const onStreamComplete = vi.fn();
    global.fetch = vi.fn().mockRejectedValue(new Error("stream failed"));

    await handleMCPJamFreeChatModel({
      messages: [] as any,
      modelId: "gpt-4.1-mini",
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as any,
      onConversationComplete,
      onStreamComplete,
    });

    await lastExecution;

    expect(onConversationComplete).not.toHaveBeenCalled();
    expect(onStreamComplete).toHaveBeenCalledTimes(1);
  });

  it("removes reasoning parts from outbound backend context", async () => {
    await handleMCPJamFreeChatModel({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "reasoning",
              text: "private chain of thought",
              state: "done",
            },
            {
              type: "text",
              text: "Visible answer",
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
            type: "text",
            text: "Visible answer",
          },
        ],
      },
    ]);
  });

  it("persists reasoning parts in order with surrounding assistant content", async () => {
    const onConversationComplete = vi.fn();
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse([
        {
          type: "reasoning-start",
          id: "reasoning-1",
        },
        {
          type: "reasoning-delta",
          id: "reasoning-1",
          delta: "Need to inspect tool inventory first.",
        },
        {
          type: "reasoning-end",
          id: "reasoning-1",
        },
        {
          type: "text-start",
          id: "text-1",
        },
        {
          type: "text-delta",
          id: "text-1",
          delta: "Connected server details:",
        },
        {
          type: "text-end",
          id: "text-1",
        },
        {
          type: "tool-input-available",
          toolCallId: "call-1",
          toolName: "list_servers",
          input: {},
        },
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]),
    );

    await handleMCPJamFreeChatModel({
      messages: [{ role: "user", content: "List my servers" }] as any,
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
    expect(fullHistory).toHaveLength(2);
    expect(fullHistory[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Need to inspect tool inventory first.",
          state: "done",
        },
        {
          type: "text",
          text: "Connected server details:",
        },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "list_servers",
          input: {},
        },
      ],
    });
  });

  it("emits ordered live trace events for a text-only streamed turn", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse([
        {
          type: "text-start",
          id: "text-1",
        },
        {
          type: "text-delta",
          id: "text-1",
          delta: "Hello from MCPJam",
        },
        {
          type: "text-end",
          id: "text-1",
        },
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        },
      ]),
    );

    await handleMCPJamFreeChatModel({
      messages: [{ role: "user", content: "Say hello" }] as any,
      modelId: "openai/gpt-5-mini",
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as any,
    });

    await lastExecution;

    const traceEvents = writtenChunks
      .filter((chunk) => chunk?.type === "data-trace-event")
      .map((chunk) => chunk.data);

    expect(traceEvents.map((event) => event.type)).toEqual([
      "turn_start",
      "request_payload",
      "text_delta",
      "trace_snapshot",
      "turn_finish",
    ]);

    expect(traceEvents[0]).toMatchObject({
      type: "turn_start",
      promptIndex: 0,
    });
    expect(traceEvents[1]).toMatchObject({
      type: "request_payload",
      promptIndex: 0,
      stepIndex: 0,
      payload: {
        system: "You are helpful",
        tools: {},
        messages: [{ role: "user", content: "Say hello" }],
      },
    });
    expect(traceEvents[3]).toMatchObject({
      type: "trace_snapshot",
      snapshot: {
        messages: [
          { role: "user", content: "Say hello" },
          {
            role: "assistant",
            content: [{ type: "text", text: "Hello from MCPJam" }],
          },
        ],
        usage: {
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
        },
      },
    });
    expect(traceEvents[3].snapshot.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "step",
          promptIndex: 0,
          stepIndex: 0,
        }),
      ]),
    );
    expect(traceEvents[4]).toMatchObject({
      type: "turn_finish",
      usage: {
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
      },
    });
  });

  it("reads token usage from messageMetadata on the finish chunk (Convex toUIMessageStreamResponse format)", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse([
        {
          type: "text-start",
          id: "text-1",
        },
        {
          type: "text-delta",
          id: "text-1",
          delta: "Hi",
        },
        {
          type: "text-end",
          id: "text-1",
        },
        {
          type: "finish",
          finishReason: "stop",
          messageMetadata: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          },
        },
      ]),
    );

    await handleMCPJamFreeChatModel({
      messages: [{ role: "user", content: "Hi" }] as any,
      modelId: "openai/gpt-5-mini",
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as any,
    });

    await lastExecution;

    const traceEvents = writtenChunks
      .filter((chunk) => chunk?.type === "data-trace-event")
      .map((chunk) => chunk.data);

    const snapshot = traceEvents.find((e: any) => e.type === "trace_snapshot");
    expect(snapshot.snapshot.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });

    const llmSpan = snapshot.snapshot.spans.find(
      (s: any) => s.category === "llm",
    );
    expect(llmSpan).toBeDefined();
    expect(llmSpan.inputTokens).toBe(10);
    expect(llmSpan.outputTokens).toBe(5);
    expect(llmSpan.totalTokens).toBe(15);

    const turnFinish = traceEvents.find((e: any) => e.type === "turn_finish");
    expect(turnFinish.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it("flushes buffered hosted rpc logs first and streams live hosted rpc logs as data parts", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    global.fetch = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const collector = createHostedRpcLogCollector({
      selectedServerIds: ["srv-notion"],
      selectedServerNames: ["Notion"],
    });

    collector.rpcLogger({
      direction: "send",
      serverId: "srv-notion",
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      },
    });

    await handleMCPJamFreeChatModel({
      messages: [{ role: "user", content: "Say hello" }] as any,
      modelId: "openai/gpt-5-mini",
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
      } as any,
      onStreamWriterReady: (writer) => collector.attachStreamWriter(writer),
    });

    expect(writtenChunks[0]).toMatchObject({
      type: "data-rpc-log",
      data: expect.objectContaining({
        serverId: "srv-notion",
        serverName: "Notion",
        direction: "send",
      }),
    });

    collector.rpcLogger({
      direction: "receive",
      serverId: "srv-notion",
      message: {
        jsonrpc: "2.0",
        id: 1,
        result: { tools: [] },
      },
    });

    resolveFetch?.(
      createSseResponse([
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]),
    );

    await lastExecution;

    const rpcChunks = writtenChunks.filter(
      (chunk) => chunk?.type === "data-rpc-log",
    );
    expect(rpcChunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            serverName: "Notion",
            direction: "send",
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            serverName: "Notion",
            direction: "receive",
          }),
        }),
      ]),
    );
  });

  it("emits tool trace events when local tool execution runs after a streamed call", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse([
        {
          type: "tool-input-available",
          toolCallId: "call-1",
          toolName: "read_docs",
          input: { topic: "latency" },
        },
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]),
    );
    vi.mocked(hasUnresolvedToolCalls).mockImplementation(
      (messages) =>
        messages.some(
          (message: any) =>
            message?.role === "assistant" &&
            Array.isArray(message.content) &&
            message.content.some((part: any) => part.type === "tool-call"),
        ) && !messages.some((message: any) => message?.role === "tool"),
    );
    vi.mocked(executeToolCallsFromMessages).mockImplementation(
      async (messages: any[]) => {
        const toolResultMessage = {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "read_docs",
              output: {
                type: "json",
                value: { ok: true },
              },
              result: { ok: true },
              serverId: "docs-server",
            },
          ],
        };
        messages.splice(2, 0, toolResultMessage);
        return [toolResultMessage] as any;
      },
    );

    await handleMCPJamFreeChatModel({
      messages: [{ role: "user", content: "Fetch the docs" }] as any,
      modelId: "openai/gpt-5-mini",
      systemPrompt: "You are helpful",
      tools: {
        read_docs: {
          _serverId: "docs-server",
        },
      } as any,
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({
          read_docs: {},
        }),
      } as any,
    });

    await lastExecution;

    const traceEvents = writtenChunks
      .filter((chunk) => chunk?.type === "data-trace-event")
      .map((chunk) => chunk.data);
    const requestPayloadEvents = traceEvents.filter(
      (event) => event.type === "request_payload",
    );

    expect(traceEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "turn_start",
        "request_payload",
        "tool_call",
        "tool_result",
        "trace_snapshot",
        "turn_finish",
      ]),
    );
    expect(traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool_call",
          toolCallId: "call-1",
          toolName: "read_docs",
          serverId: "docs-server",
          input: { topic: "latency" },
        }),
        expect.objectContaining({
          type: "tool_result",
          toolCallId: "call-1",
          toolName: "read_docs",
          serverId: "docs-server",
          output: expect.objectContaining({
            ok: true,
          }),
        }),
      ]),
    );
    expect(requestPayloadEvents).toHaveLength(2);
    expect(requestPayloadEvents.map((event) => event.stepIndex)).toEqual([
      0, 1,
    ]);
    expect(requestPayloadEvents[0]).toMatchObject({
      payload: {
        messages: [{ role: "user", content: "Fetch the docs" }],
      },
    });
    expect(requestPayloadEvents[1]).toMatchObject({
      payload: {
        messages: [
          { role: "user", content: "Fetch the docs" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "read_docs",
                input: { topic: "latency" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              expect.objectContaining({
                type: "tool-result",
                toolCallId: "call-1",
                toolName: "read_docs",
              }),
            ],
          },
        ],
      },
    });
  });
});
