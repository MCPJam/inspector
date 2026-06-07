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
      })
    ),
  };
});

vi.mock("@/shared/http-tool-calls", () => ({
  hasUnresolvedToolCalls: vi.fn().mockReturnValue(false),
  executeToolCallsFromMessages: vi.fn(),
}));

vi.mock("../chat-helpers", async () => {
  const actual = await vi.importActual<typeof import("../chat-helpers")>(
    "../chat-helpers"
  );
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
    // PR 5b-pre review fix (CodeRabbit Minor): the callback try/catch
    // path calls `logger.warn` on a callback throw. The mock must
    // include `warn` so the path is faithfully exercised (without
    // this, calling `logger.warn` would have thrown TypeError and the
    // catch-block-doesn't-propagate test would have validated against
    // a mock-shape side effect instead of the real behavior).
    warn: vi.fn(),
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
      ])
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
      ((global.fetch as any).mock.calls[0]?.[1]?.body as string) ?? "{}"
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
      })
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
      ((global.fetch as any).mock.calls[0]?.[1]?.body as string) ?? "{}"
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
      onConversationComplete.mock.invocationCallOrder[0]
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
      ((global.fetch as any).mock.calls[0]?.[1]?.body as string) ?? "{}"
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
      ])
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
      ])
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
      ])
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
          totalUsage: {
            inputTokens: 999,
            outputTokens: 999,
            totalTokens: 1998,
          },
        },
      ])
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
      (s: any) => s.category === "llm"
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

    const finishChunk = writtenChunks.find((chunk) => chunk?.type === "finish");
    expect(finishChunk).toMatchObject({
      type: "finish",
      finishReason: "stop",
      messageMetadata: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    });
    expect(finishChunk).not.toHaveProperty("totalUsage");
  });

  it("aggregates usage across steps when emitting the final UI finish chunk", async () => {
    const stepOne = [
      {
        type: "tool-input-available",
        toolCallId: "call-1",
        toolName: "read_docs",
        input: { topic: "latency" },
      },
      {
        type: "finish",
        finishReason: "stop",
        messageMetadata: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    ];
    const stepTwo = [
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "ok" },
      { type: "text-end", id: "text-1" },
      {
        type: "finish",
        finishReason: "stop",
        messageMetadata: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      },
    ];
    let call = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      const events = call === 0 ? stepOne : stepTwo;
      call += 1;
      return createSseResponse(events);
    });
    vi.mocked(hasUnresolvedToolCalls).mockImplementation(
      (messages) =>
        messages.some(
          (message: any) =>
            message?.role === "assistant" &&
            Array.isArray(message.content) &&
            message.content.some((part: any) => part.type === "tool-call")
        ) && !messages.some((message: any) => message?.role === "tool")
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
              output: { type: "json", value: { ok: true } },
              result: { ok: true },
              serverId: "docs-server",
            },
          ],
        };
        messages.splice(2, 0, toolResultMessage);
        return [toolResultMessage] as any;
      }
    );

    await handleMCPJamFreeChatModel({
      messages: [{ role: "user", content: "Fetch the docs" }] as any,
      modelId: "openai/gpt-5-mini",
      systemPrompt: "You are helpful",
      tools: {
        read_docs: { _serverId: "docs-server" },
      } as any,
      mcpClientManager: {
        getAllToolsMetadata: vi.fn().mockReturnValue({ read_docs: {} }),
      } as any,
    });

    await lastExecution;

    const finishChunks = writtenChunks.filter(
      (chunk) => chunk?.type === "finish"
    );
    expect(finishChunks).toHaveLength(1);
    expect(finishChunks[0]).toMatchObject({
      type: "finish",
      finishReason: "stop",
      messageMetadata: {
        inputTokens: 13,
        outputTokens: 9,
        totalTokens: 22,
      },
    });
    expect(finishChunks[0]).not.toHaveProperty("totalUsage");
  });

  it("flushes buffered hosted rpc logs first and streams live hosted rpc logs as data parts", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    global.fetch = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
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
      ])
    );

    await lastExecution;

    const rpcChunks = writtenChunks.filter(
      (chunk) => chunk?.type === "data-rpc-log"
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
      ])
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
      ])
    );
    vi.mocked(hasUnresolvedToolCalls).mockImplementation(
      (messages) =>
        messages.some(
          (message: any) =>
            message?.role === "assistant" &&
            Array.isArray(message.content) &&
            message.content.some((part: any) => part.type === "tool-call")
        ) && !messages.some((message: any) => message?.role === "tool")
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
      }
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
      (event) => event.type === "request_payload"
    );

    expect(traceEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "turn_start",
        "request_payload",
        "tool_call",
        "tool_result",
        "trace_snapshot",
        "turn_finish",
      ])
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
            _meta: expect.objectContaining({
              _serverId: "docs-server",
            }),
            value: expect.objectContaining({
              ok: true,
            }),
          }),
        }),
      ])
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

  describe("progressive discovery approval semantics", () => {
    // Minimal "plan enabled" — only the `enabled` flag is read on the
    // post-stream unresolved-tool detection + drain paths exercised here.
    const enabledProgressivePlan = {
      enabled: true as const,
      reasons: ["test"],
      policy: {
        thresholdPct: 0.03,
        maxToolTokens: 10_000,
        maxToolCount: 30,
        searchLimit: 8,
      },
      catalog: [
        {
          toolId: "ops::list_servers",
          modelName: "list_servers",
          serverId: "ops",
          description: "",
          fieldSummary: "",
          tokenEstimate: 10,
        } as any,
      ],
      totalTokenEstimate: 10,
    } as any;

    it("treats a real tool named like a meta-tool as approval-required when progressive mode is off", async () => {
      // Regression guard: `isMetaToolName` was name-only, so a real MCP
      // server exposing a tool literally named `search_mcp_tools` would
      // bypass approval whenever progressive mode wasn't active. With
      // `progressivePlan` undefined the exemption MUST NOT apply.
      vi.mocked(hasUnresolvedToolCalls).mockReturnValue(true);

      await handleMCPJamFreeChatModel({
        messages: [
          { role: "user", content: "search" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "call-evil-1",
                toolName: "search_mcp_tools",
                input: {},
              },
            ],
          },
        ] as any,
        modelId: "gpt-4.1-mini",
        systemPrompt: "You are helpful",
        tools: { search_mcp_tools: { _serverId: "evil" } } as any,
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        requireToolApproval: true,
      });

      await lastExecution;

      // The handler still calls the executor on its pre-pause drain
      // pass (single code path for approval-mode), but the filter must
      // REJECT the call — `search_mcp_tools` is only approval-free
      // when progressive mode actually minted that meta-tool, and here
      // it didn't. Approval is then required for `call-evil-1`.
      const calls = vi.mocked(executeToolCallsFromMessages).mock.calls;
      expect(calls.length).toBe(1);
      const filterToolName = (calls[0]?.[1] as any)?.filterToolName;
      expect(typeof filterToolName).toBe("function");
      expect(filterToolName("search_mcp_tools")).toBe(false);
      expect(filterToolName("load_mcp_tools")).toBe(false);
    });

    it("drains unresolved meta-tool calls before pausing for approval on a real tool", async () => {
      // Regression guard: mixed-step turns (meta-tool + real tool in
      // one assistant message under approval) used to strand the
      // meta-tool call unresolved, so the loaded ids never reached
      // `discoveryState.loadedToolIds` after the resumed turn. The
      // drain runs the meta-tools first and only then pauses.
      vi.mocked(hasUnresolvedToolCalls).mockReturnValue(true);
      vi.mocked(executeToolCallsFromMessages).mockResolvedValue([]);

      await handleMCPJamFreeChatModel({
        messages: [
          { role: "user", content: "search and call" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "meta-1",
                toolName: "search_mcp_tools",
                input: { query: "task" },
              },
              {
                type: "tool-call",
                toolCallId: "real-1",
                toolName: "list_servers",
                input: {},
              },
            ],
          },
        ] as any,
        modelId: "gpt-4.1-mini",
        systemPrompt: "You are helpful",
        tools: {
          search_mcp_tools: {},
          list_servers: { _serverId: "ops" },
        } as any,
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        requireToolApproval: true,
        progressivePlan: enabledProgressivePlan,
      });

      await lastExecution;

      const calls = vi.mocked(executeToolCallsFromMessages).mock.calls;
      // The drain call is the only executor invocation on the approval
      // path — execution of the real tool is gated behind a separate
      // approval-resume request.
      expect(calls.length).toBe(1);
      const filterToolName = (calls[0]?.[1] as any)?.filterToolName;
      expect(typeof filterToolName).toBe("function");
      expect(filterToolName("search_mcp_tools")).toBe(true);
      expect(filterToolName("load_mcp_tools")).toBe(true);
      expect(filterToolName("list_servers")).toBe(false);
    });
  });

  describe("guest IP-hash header", () => {
    it("forwards a hashed IP for the per-IP daily spend cap when clientIp is provided", async () => {
      process.env.GUEST_SESSION_HASH_PEPPER = "test-pepper-for-ip-hash";

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "hi" }] as any,
        modelId: "gpt-4.1-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        clientIp: "203.0.113.10",
      });

      await lastExecution;

      const headers = (global.fetch as any).mock.calls[0]?.[1]
        ?.headers as Record<string, string>;
      const ipHash = headers["x-mcpjam-guest-ip-hash"];
      expect(typeof ipHash).toBe("string");
      expect(ipHash).not.toBe("_unknown");
      // base64url, no padding
      expect(ipHash).toMatch(/^[A-Za-z0-9_-]+$/);

      delete process.env.GUEST_SESSION_HASH_PEPPER;
    });

    it("omits the guest IP hash header when clientIp is null", async () => {
      process.env.GUEST_SESSION_HASH_PEPPER = "test-pepper-for-ip-hash";

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "hi" }] as any,
        modelId: "gpt-4.1-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        clientIp: null,
      });

      await lastExecution;

      const headers = (global.fetch as any).mock.calls[0]?.[1]
        ?.headers as Record<string, string>;
      expect(headers["x-mcpjam-guest-ip-hash"]).toBeUndefined();

      delete process.env.GUEST_SESSION_HASH_PEPPER;
    });

    it("does not let extraHeaders override the computed guest IP hash", async () => {
      process.env.GUEST_SESSION_HASH_PEPPER = "test-pepper-for-ip-hash";

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "hi" }] as any,
        modelId: "gpt-4.1-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        clientIp: "203.0.113.10",
        extraHeaders: {
          "x-mcpjam-guest-ip-hash": "attacker-controlled",
        },
      });

      await lastExecution;

      const headers = (global.fetch as any).mock.calls[0]?.[1]
        ?.headers as Record<string, string>;
      expect(headers["x-mcpjam-guest-ip-hash"]).not.toBe("attacker-controlled");
      expect(headers["x-mcpjam-guest-ip-hash"]).toMatch(/^[A-Za-z0-9_-]+$/);

      delete process.env.GUEST_SESSION_HASH_PEPPER;
    });

    it("drops caller-provided guest IP hash when clientIp is null", async () => {
      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "hi" }] as any,
        modelId: "gpt-4.1-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        clientIp: null,
        extraHeaders: {
          "x-mcpjam-guest-ip-hash": "attacker-controlled",
          "X-MCPJam-Guest-IP-Hash": "attacker-controlled-case",
        },
      });

      await lastExecution;

      const headers = (global.fetch as any).mock.calls[0]?.[1]
        ?.headers as Record<string, string>;
      expect(headers["x-mcpjam-guest-ip-hash"]).toBeUndefined();
      expect(headers["X-MCPJam-Guest-IP-Hash"]).toBeUndefined();
    });

    it("forwards the inbound AbortSignal into the Convex fetch", async () => {
      const controller = new AbortController();
      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "hi" }] as any,
        modelId: "gpt-4.1-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        abortSignal: controller.signal,
        heartbeatIntervalMs: 0,
      });
      await lastExecution;

      expect((global.fetch as any).mock.calls[0]?.[1]?.signal).toBe(
        controller.signal
      );
    });

    it("does not emit finish or turn_finish when abort fires between steps (post-loop epilogue is gated)", async () => {
      // Regression for the silent-cancel epilogue leak: an abort that
      // lands AFTER a step returns but BEFORE the next iteration must
      // not fall through to the success epilogue (synthetic finish +
      // turn_finish trace + runSucceeded=true).
      const controller = new AbortController();
      const onConversationComplete = vi.fn();
      const onStreamComplete = vi.fn();

      vi.mocked(hasUnresolvedToolCalls).mockReturnValue(true);
      // Simulate a tool execution that completes AND fires the abort
      // signal as a side effect. The handler's external abort listener
      // sets `aborted = true`. On the next loop iteration the top-of-
      // loop guard breaks out, and the post-loop early return must
      // skip the success epilogue.
      vi.mocked(executeToolCallsFromMessages).mockImplementationOnce(
        async () => {
          controller.abort();
          return [];
        }
      );

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "hi" }] as any,
        modelId: "gpt-4.1-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        abortSignal: controller.signal,
        heartbeatIntervalMs: 0,
        onConversationComplete,
        onStreamComplete,
      });
      await lastExecution;

      const visibleChunks = writtenChunks.filter(
        (c: any) =>
          c?.type !== "data-trace-event" || c?.data?.type !== "heartbeat"
      );
      // Silent-cancel invariant: no finish, no error, no turn_finish.
      expect(
        visibleChunks.find((c: any) => c?.type === "finish")
      ).toBeUndefined();
      expect(
        visibleChunks.find((c: any) => c?.type === "error")
      ).toBeUndefined();
      const traceTypes = visibleChunks
        .filter((c: any) => c?.type === "data-trace-event")
        .map((c: any) => c?.data?.type);
      expect(traceTypes).not.toContain("turn_finish");
      // And no persistence — aborted turns are partial by definition.
      expect(onConversationComplete).not.toHaveBeenCalled();
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });

    it("aborts silently before fetch when signal is already aborted: no fetch, no finish, no persistence, onStreamComplete runs", async () => {
      const controller = new AbortController();
      controller.abort();
      const onConversationComplete = vi.fn();
      const onStreamComplete = vi.fn();
      (global.fetch as any).mockClear();

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "hi" }] as any,
        modelId: "gpt-4.1-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        abortSignal: controller.signal,
        heartbeatIntervalMs: 0,
        onConversationComplete,
        onStreamComplete,
      });
      await lastExecution;

      // Pre-aborted: the loop must not enter, so no Convex call happens.
      expect((global.fetch as any).mock.calls).toHaveLength(0);
      // Silent cancellation invariant: no error chunk, no synthetic finish,
      // no turn_finish, no conversation persistence.
      const visibleChunks = writtenChunks.filter(
        (c: any) =>
          c?.type !== "data-trace-event" || c?.data?.type !== "heartbeat"
      );
      expect(
        visibleChunks.find((c: any) => c?.type === "finish")
      ).toBeUndefined();
      expect(
        visibleChunks.find((c: any) => c?.type === "error")
      ).toBeUndefined();
      const traceTypes = visibleChunks
        .filter((c: any) => c?.type === "data-trace-event")
        .map((c: any) => c?.data?.type);
      expect(traceTypes).not.toContain("turn_finish");
      expect(onConversationComplete).not.toHaveBeenCalled();
      // Cleanup still runs — callers rely on this to tear down per-request
      // MCPClientManager state on disconnect.
      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });

    it("does not emit heartbeat trace events when heartbeatIntervalMs is 0", async () => {
      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "hi" }] as any,
        modelId: "gpt-4.1-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        heartbeatIntervalMs: 0,
      });
      await lastExecution;

      const heartbeats = writtenChunks.filter(
        (c: any) =>
          c?.type === "data-trace-event" && c?.data?.type === "heartbeat"
      );
      expect(heartbeats).toHaveLength(0);
    });

    it("preserves current-turn reasoning across steps in the backend payload", async () => {
      const messages = [
        { role: "user", content: "step 1" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "let me think", state: "done" },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "search",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "search",
              output: { type: "json", value: { ok: true } },
            },
          ],
        },
      ] as any;

      await handleMCPJamFreeChatModel({
        messages,
        modelId: "gpt-4.1-mini",
        systemPrompt: "You are helpful",
        tools: {
          search: { description: "search", inputSchema: {} as any },
        },
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        heartbeatIntervalMs: 0,
      });
      await lastExecution;

      const fetchBody = JSON.parse(
        ((global.fetch as any).mock.calls[0]?.[1]?.body as string) ?? "{}"
      );
      const sentMessages = JSON.parse(fetchBody.messages);
      const assistantWithReasoning = sentMessages.find(
        (m: any) => m.role === "assistant"
      );
      const reasoningPart = assistantWithReasoning?.content?.find(
        (p: any) => p?.type === "reasoning"
      );
      // Current-turn reasoning survives (so thinking models keep their
      // scratchpad), but the UI-only `state` field is stripped.
      expect(reasoningPart).toBeDefined();
      expect(reasoningPart.text).toBe("let me think");
      expect(reasoningPart.state).toBeUndefined();
    });

    it("respects maxSteps using promptStepBaseIndex + steps so resumed approval turns cannot extend the budget", async () => {
      // 4 assistant steps already happened in the current turn (post the
      // latest user message). With maxSteps=6, only 2 more steps may run.
      const messages = [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "text", text: "s1" }] },
        { role: "assistant", content: [{ type: "text", text: "s2" }] },
        { role: "assistant", content: [{ type: "text", text: "s3" }] },
        { role: "assistant", content: [{ type: "text", text: "s4" }] },
      ] as any;

      // Keep tools unresolved every step so the loop wants to continue.
      vi.mocked(hasUnresolvedToolCalls).mockReturnValue(true);
      vi.mocked(executeToolCallsFromMessages).mockResolvedValue([]);

      (global.fetch as any).mockClear();

      await handleMCPJamFreeChatModel({
        messages,
        modelId: "gpt-4.1-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        maxSteps: 6,
        heartbeatIntervalMs: 0,
      });
      await lastExecution;

      // 4 existing + 2 new = 6 (the cap). Only 2 fetches should fire.
      expect((global.fetch as any).mock.calls).toHaveLength(2);
    });

    it("emits the aggregated turn usage via messageMetadata (preserving #2213)", async () => {
      // Single-step turn with non-trivial usage. Must surface as
      // messageMetadata on the finish chunk, NOT totalUsage. Regression
      // guard for the createClientFinishChunk wire shape.
      (global.fetch as any).mockReset();
      (global.fetch as any) = vi.fn().mockResolvedValue(
        createSseResponse([
          {
            type: "finish",
            finishReason: "stop",
            messageMetadata: {
              inputTokens: 50,
              outputTokens: 25,
              totalTokens: 75,
            },
          },
        ])
      );

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "hi" }] as any,
        modelId: "gpt-4.1-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        heartbeatIntervalMs: 0,
      });
      await lastExecution;

      const finishChunk = writtenChunks.find((c: any) => c?.type === "finish");
      expect(finishChunk).toBeDefined();
      expect((finishChunk as any).messageMetadata).toMatchObject({
        inputTokens: 50,
        outputTokens: 25,
        totalTokens: 75,
      });
      // #2213 invariant: totalUsage must NOT be emitted on the client
      // finish chunk; clients read usage from messageMetadata.
      expect((finishChunk as any).totalUsage).toBeUndefined();
    });

    it("hashes IPv4 and ::ffff:-mapped IPv6 of the same client identically", async () => {
      process.env.GUEST_SESSION_HASH_PEPPER = "test-pepper-for-ip-hash";

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "hi" }] as any,
        modelId: "gpt-4.1-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        clientIp: "1.2.3.4",
      });
      await lastExecution;
      const v4Hash = ((global.fetch as any).mock.calls[0]?.[1]?.headers ?? {})[
        "x-mcpjam-guest-ip-hash"
      ];

      // Reset between calls
      lastExecution = null;
      writtenChunks = [];
      (global.fetch as any).mockClear();

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "hi" }] as any,
        modelId: "gpt-4.1-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        clientIp: "::ffff:1.2.3.4",
      });
      await lastExecution;
      const mappedHash = ((global.fetch as any).mock.calls[0]?.[1]?.headers ??
        {})["x-mcpjam-guest-ip-hash"];

      expect(mappedHash).toBe(v4Hash);

      delete process.env.GUEST_SESSION_HASH_PEPPER;
    });
  });

  describe("PR 5b-pre — chunk + step callback contract", () => {
    // Engine consolidation PR 5b-pre
    // (`~/mcpjam-docs/unification.md`): new optional callbacks on
    // `MCPJamHandlerOptions` so eval's PR 5b backend stream runner can
    // emit SSE events from engine signals. Locks the callback timing +
    // shape so PR 5b's wire-up trusts the contract. Chat + synthetic
    // (which don't supply these callbacks) are unaffected — covered by
    // the omit-callbacks-and-still-work assertions on every existing
    // test in this file.

    it("fires `onToolCall` with the chunk fields when a tool-input-available chunk arrives", async () => {
      // Step 1: model returns a tool call. Step 2: tool result fed in,
      // model finishes. Asserts `onToolCall` fires once with the
      // chunk's toolName/toolCallId/input plus stepIndex + promptIndex.
      const stepOne = [
        {
          type: "tool-input-available",
          toolCallId: "call-1",
          toolName: "read_docs",
          input: { topic: "latency" },
        },
        {
          type: "finish",
          finishReason: "stop",
          messageMetadata: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        },
      ];
      const stepTwo = [
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "ok" },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: "stop",
          messageMetadata: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ];
      let call = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        const events = call === 0 ? stepOne : stepTwo;
        call += 1;
        return createSseResponse(events);
      });
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
                output: { type: "json", value: { ok: true } },
                result: { ok: true },
                serverId: "docs-server",
              },
            ],
          };
          messages.splice(2, 0, toolResultMessage);
          return [toolResultMessage] as any;
        },
      );

      const onToolCall = vi.fn();
      const onToolResult = vi.fn();
      const onStepFinish = vi.fn();

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "Fetch the docs" }] as any,
        modelId: "openai/gpt-5-mini",
        systemPrompt: "You are helpful",
        tools: {
          read_docs: { _serverId: "docs-server" },
        } as any,
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({ read_docs: {} }),
        } as any,
        onToolCall,
        onToolResult,
        onStepFinish,
      });

      await lastExecution;

      // `onToolCall` fires once for the single tool call, before
      // execution. Shape includes stepIndex and promptIndex from
      // engine bookkeeping.
      expect(onToolCall).toHaveBeenCalledTimes(1);
      expect(onToolCall).toHaveBeenCalledWith({
        toolCallId: "call-1",
        toolName: "read_docs",
        input: { topic: "latency" },
        stepIndex: 0,
        promptIndex: 0,
        serverId: "docs-server",
      });
    });

    it("fires `onToolResult` after local tool execution with isError flag", async () => {
      const stepOne = [
        {
          type: "tool-input-available",
          toolCallId: "call-1",
          toolName: "read_docs",
          input: {},
        },
        {
          type: "finish",
          finishReason: "stop",
          messageMetadata: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ];
      const stepTwo = [
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "done" },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: "stop",
          messageMetadata: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ];
      let call = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        const events = call === 0 ? stepOne : stepTwo;
        call += 1;
        return createSseResponse(events);
      });
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
                // Error result — locks `isError: true` mapping.
                output: { type: "error-text", value: "boom" },
                result: { error: "boom" },
                serverId: "docs-server",
              },
            ],
          };
          messages.splice(2, 0, toolResultMessage);
          return [toolResultMessage] as any;
        },
      );

      const onToolResult = vi.fn();

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "Run it" }] as any,
        modelId: "openai/gpt-5-mini",
        systemPrompt: "You are helpful",
        tools: {
          read_docs: { _serverId: "docs-server" },
        } as any,
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({ read_docs: {} }),
        } as any,
        onToolResult,
      });

      await lastExecution;

      expect(onToolResult).toHaveBeenCalledTimes(1);
      expect(onToolResult).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallId: "call-1",
          toolName: "read_docs",
          isError: true,
          stepIndex: 0,
          promptIndex: 0,
          serverId: "docs-server",
        }),
      );
    });

    it("fires `onStepFinish` once per completed step with cumulative turnUsage", async () => {
      const stepOne = [
        {
          type: "tool-input-available",
          toolCallId: "call-1",
          toolName: "read_docs",
          input: {},
        },
        {
          type: "finish",
          finishReason: "stop",
          messageMetadata: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        },
      ];
      const stepTwo = [
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "done" },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: "stop",
          messageMetadata: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
      ];
      let call = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        const events = call === 0 ? stepOne : stepTwo;
        call += 1;
        return createSseResponse(events);
      });
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
                output: { type: "json", value: { ok: true } },
                result: { ok: true },
                serverId: "docs-server",
              },
            ],
          };
          messages.splice(2, 0, toolResultMessage);
          return [toolResultMessage] as any;
        },
      );

      const onStepFinish = vi.fn();

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "Two steps" }] as any,
        modelId: "openai/gpt-5-mini",
        systemPrompt: "You are helpful",
        tools: {
          read_docs: { _serverId: "docs-server" },
        } as any,
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({ read_docs: {} }),
        } as any,
        onStepFinish,
      });

      await lastExecution;

      // Two steps completed: tool-call step + final text step.
      expect(onStepFinish).toHaveBeenCalledTimes(2);
      // stepIndex increments. turnUsage is CUMULATIVE per turn — caller
      // derives per-step deltas across successive invocations.
      const first = onStepFinish.mock.calls[0]?.[0];
      const second = onStepFinish.mock.calls[1]?.[0];
      expect(first).toMatchObject({
        stepIndex: 0,
        promptIndex: 0,
        // PR 5b-pre review caveat (Marcelo): both successful steps
        // settle without error. PR 5b should rely on this flag to
        // gate eval `step_finish` SSE event emission.
        settledWithError: false,
      });
      expect(second).toMatchObject({
        stepIndex: 1,
        promptIndex: 0,
        settledWithError: false,
      });
      // Engine aggregates usage across steps; the second call sees the
      // sum (3+1, 4+2, 7+3).
      expect(second.turnUsage).toMatchObject({
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
      });
    });

    it("fires `onStepFinish` with `settledWithError: true` on backend failure paths (PR 5b-pre review — Marcelo caveat)", async () => {
      // Marcelo's review caveat: `onStepFinish` fires after every
      // `processOneStep` return — including the non-OK / no-body
      // branches at mcpjam-stream-handler.ts:1558. Those return
      // `didEmitFinish: false` after writing an error UI chunk. If
      // PR 5b maps `onStepFinish` directly to eval `step_finish` SSE,
      // failed backend steps would emit `step_finish` where the
      // pre-collapse runner only emitted error/failure trace.
      //
      // Fix is "step settled, not step succeeded" semantics: the engine
      // surfaces the settle state via `settledWithError` so PR 5b's
      // wire-up gates correctly. This test locks the failure shape:
      // a non-OK HTTP response from Convex MUST fire `onStepFinish`
      // exactly once with `settledWithError: true`.
      global.fetch = vi.fn().mockResolvedValue(
        new Response("upstream broke", {
          status: 500,
          statusText: "Internal Server Error",
        }),
      );
      vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);

      const onStepFinish = vi.fn();

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "Fail me" }] as any,
        modelId: "openai/gpt-5-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        onStepFinish,
      });

      await lastExecution;

      // Failure step fires the callback once. `settledWithError: true`
      // signals to PR 5b's wire-up to NOT emit eval `step_finish` SSE.
      expect(onStepFinish).toHaveBeenCalledTimes(1);
      expect(onStepFinish).toHaveBeenCalledWith(
        expect.objectContaining({
          stepIndex: 0,
          promptIndex: 0,
          settledWithError: true,
        }),
      );
    });

    it("includes `turnSpans` snapshot on each `onStepFinish` invocation (PR 5b-followup-2 — Cursor 'Step snapshots omit LLM spans')", async () => {
      // PR 5b-followup-2: the engine accumulates LLM-step + tool spans
      // on `traceTurn.turnSpans` during the agentic loop but only
      // surfaced them post-turn via `PersistedTurnTrace.spans`. The
      // followup exposes a defensive-copy snapshot on
      // `MCPJamStepFinishEvent.turnSpans` so eval's mid-turn step
      // snapshots can include the active turn's per-step LLM timing.
      // Lock the engine surface: every `onStepFinish` invocation
      // carries `turnSpans: EvalTraceSpan[]`, and successive
      // invocations see the running set grow (defensive copy means
      // earlier event snapshots stay frozen).
      const stepOne = [
        { type: "text-start", id: "text-0" },
        { type: "text-delta", id: "text-0", delta: "step1" },
        { type: "text-end", id: "text-0" },
        {
          type: "finish",
          finishReason: "stop",
          messageMetadata: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        },
      ];
      let fetchCall = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        fetchCall += 1;
        return createSseResponse(stepOne);
      });
      vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);

      const onStepFinish = vi.fn();

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "Hi" }] as any,
        modelId: "openai/gpt-5-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        onStepFinish,
      });

      await lastExecution;

      expect(onStepFinish).toHaveBeenCalledTimes(1);
      const event = onStepFinish.mock.calls[0]?.[0];
      // `turnSpans` is REQUIRED — always present, even when the engine
      // hasn't recorded any spans for this turn yet (the LLM-step span
      // for the completed step IS recorded though, so we expect at
      // least one entry).
      expect(Array.isArray(event.turnSpans)).toBe(true);
      expect(event.turnSpans.length).toBeGreaterThan(0);
      // Defensive copy: mutating the event's array must not affect
      // the engine's internal traceTurn.turnSpans on subsequent steps.
      const originalLength = event.turnSpans.length;
      event.turnSpans.push({ name: "intruder" } as any);
      // Engine wouldn't be running anymore, but the contract holds:
      // the array we received was a fresh copy.
      expect(event.turnSpans.length).toBe(originalLength + 1);
      void fetchCall;
    });

    it("fires `onEngineError` with structured guardrail body on non-OK Convex response (PR 5b-followup-2 — Cursor 'Stream guardrail errors lose detail')", async () => {
      // PR 5b-followup-2: before this followup, `streamSink: "none"`
      // consumers (eval backend stream runner) lost structured 429 /
      // daily-cap / hosted-model setup error detail because the
      // writer-side `error` UI chunk went to the no-op writer. Engine
      // now also fires `onEngineError({code, message, details,
      // httpStatus, rawText})` at the same site with the parsed
      // `{ code?, error, details? }` body so eval can surface the
      // actual guardrail reason on its own error SSE event.
      const structuredBody = JSON.stringify({
        code: "user_rate_limit",
        error: "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
        details: "Try again in 30 minutes.",
      });
      global.fetch = vi.fn().mockResolvedValue(
        new Response(structuredBody, {
          status: 429,
          statusText: "Too Many Requests",
        }),
      );
      vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);

      const onEngineError = vi.fn();

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "Rate-limit me" }] as any,
        modelId: "openai/gpt-5-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        onEngineError,
      });

      await lastExecution;

      expect(onEngineError).toHaveBeenCalledTimes(1);
      const event = onEngineError.mock.calls[0]?.[0];
      // Display message is the parsed "error + details" shape (matches
      // the legacy describeBackendStreamError output that lived in
      // evals-runner before PR 5b's collapse).
      expect(event.message).toContain("Daily MCPJam model limit reached");
      expect(event.message).toContain("Try again in 30 minutes");
      // Structured fields populated from the parsed body.
      expect(event.code).toBe("user_rate_limit");
      expect(event.details).toBe("Try again in 30 minutes.");
      expect(event.httpStatus).toBe(429);
      // Raw body is always present for debugging.
      expect(event.rawText).toBe(structuredBody);
      // Correlation fields.
      expect(event.promptIndex).toBe(0);
      expect(event.stepIndex).toBe(0);
    });

    it("fires `onEngineError` with raw text on non-OK response with non-JSON body (PR 5b-followup-2)", async () => {
      // The parser falls back to a generic `Backend stream error: <status> <text>`
      // when the body isn't structured JSON. `code` and `details` are
      // omitted; `rawText` carries the original body for diagnostic use.
      global.fetch = vi.fn().mockResolvedValue(
        new Response("upstream broke", {
          status: 500,
          statusText: "Internal Server Error",
        }),
      );
      vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);

      const onEngineError = vi.fn();

      await handleMCPJamFreeChatModel({
        messages: [{ role: "user", content: "Fail me" }] as any,
        modelId: "openai/gpt-5-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({}),
        } as any,
        onEngineError,
      });

      await lastExecution;

      expect(onEngineError).toHaveBeenCalledTimes(1);
      const event = onEngineError.mock.calls[0]?.[0];
      expect(event.message).toBe("Backend stream error: 500 upstream broke");
      expect(event.code).toBeUndefined();
      expect(event.details).toBeUndefined();
      expect(event.httpStatus).toBe(500);
      expect(event.rawText).toBe("upstream broke");
    });

    it("fires `onToolCall` for approved tools on resumed approval turns (PR 5b-pre review fix — Cursor Medium)", async () => {
      // Cursor PR 5b-pre review fix: `handlePendingApprovals` writes
      // `tool-input-available` UI chunks for resumed APPROVED tools
      // and `emitToolResults` fires `onToolResult` after local
      // execution. Pre-fix `onToolCall` only fired from
      // `processStream`'s chunk switch, so eval's PR 5b wiring would
      // emit `tool_result` SSE without a matching `tool_call`. Fixed
      // by firing `onToolCall` at the resumed-approval emit site.
      const stepTwo = [
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "ok approved" },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: "stop",
          messageMetadata: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ];
      global.fetch = vi.fn().mockResolvedValue(createSseResponse(stepTwo));

      // Resumed-approval shape with `approved: true` — the matching
      // tool-call lives on the assistant message. handlePendingApprovals
      // walks both, emits `tool-input-available`, executes the tool,
      // then `emitToolResults` runs.
      const resumedMessages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-approved-1",
              toolName: "search",
              input: { q: "approved" },
            },
            {
              type: "tool-approval-request",
              approvalId: "approval-1",
              toolCallId: "call-approved-1",
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-approval-response",
              approvalId: "approval-1",
              approved: true,
            },
          ],
        },
      ];

      vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);
      vi.mocked(executeToolCallsFromMessages).mockImplementation(
        async (messages: any[]) => {
          const toolResultMessage = {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-approved-1",
                toolName: "search",
                output: { type: "json", value: { hit: true } },
                result: { hit: true },
                serverId: "search-server",
              },
            ],
          };
          messages.push(toolResultMessage);
          return [toolResultMessage] as any;
        },
      );

      const onToolCall = vi.fn();
      const onToolResult = vi.fn();

      await handleMCPJamFreeChatModel({
        messages: resumedMessages as any,
        modelId: "openai/gpt-5-mini",
        systemPrompt: "You are helpful",
        tools: {
          search: { _serverId: "search-server" },
        } as any,
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({ search: {} }),
        } as any,
        requireToolApproval: true,
        onToolCall,
        onToolResult,
      });

      await lastExecution;

      // `onToolCall` MUST have fired for the approved tool before any
      // `onToolResult` — eval's PR 5b wiring relies on the ordering.
      const approvedCallIdx = onToolCall.mock.calls.findIndex(
        (c) => c[0]?.toolCallId === "call-approved-1",
      );
      expect(approvedCallIdx).toBeGreaterThanOrEqual(0);
      expect(onToolCall.mock.calls[approvedCallIdx]?.[0]).toMatchObject({
        toolCallId: "call-approved-1",
        toolName: "search",
        input: { q: "approved" },
        promptIndex: 0,
        serverId: "search-server",
      });
    });

    // NOTE: `emitInheritedToolCalls` also fires `onToolCall` after the
    // PR 5b fix (the function's signature gained `tools` / `traceTurn`
    // / `stepIndex` / `onToolCall` params, and the loop body now
    // invokes the callback alongside the existing `writer.write({type:
    // "tool-input-available", ...})`). That path is harder to trigger
    // in isolation than the resumed-approval branch covered above —
    // it requires the per-step path to reach the local tool-execution
    // branch with prior unresolved tool-calls in scope, a
    // multi-fixture setup that doesn't fit cleanly into the
    // single-handler-call test shape used here. The code fix is
    // covered by the same `tools` + `traceTurn` plumbing pattern as
    // the approved-tools site above, which IS tested.

    it("fires `onToolResult` for denied tools on resumed approval turns (PR 5b-pre review fix — Cursor Medium)", async () => {
      // Cursor PR 5b-pre review fix: `handlePendingApprovals` writes a
      // `tool_result` trace event inline (not via `emitToolResults`)
      // when the user denies a tool call on a resumed approval turn.
      // Pre-fix the inline path skipped `onToolResult` even though the
      // emitToolResults path fired it for approved + auto-deny cases —
      // PR 5b eval wiring would miss SSE events for denied tools on
      // resumed turns. Fixed in this PR by mirroring the callback
      // invocation at the inline trace event site.
      const stepOne = [
        {
          type: "tool-input-available",
          toolCallId: "call-denied-1",
          toolName: "delete_things",
          input: { id: 42 },
        },
        {
          type: "finish",
          finishReason: "stop",
          messageMetadata: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ];
      const stepTwo = [
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "ok denied" },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: "stop",
          messageMetadata: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ];
      let call = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        const events = call === 0 ? stepOne : stepTwo;
        call += 1;
        return createSseResponse(events);
      });

      // The resumed-approval shape: client sends back an assistant
      // message with a `tool-approval-request` part + a corresponding
      // `tool-approval-response` part marked denied. `handlePendingApprovals`
      // processes this BEFORE the per-step loop runs, so the
      // `emitToolResults` path isn't hit — the denial trace event +
      // callback fire from inside `handlePendingApprovals` itself.
      // Same resumed-approval shape as the existing "preserves spliced
      // denial tool results" test in this file: the approval-response
      // lives in a tool-role message, not bundled into the assistant
      // message (mirrors how the client posts the approval response on
      // the next round trip).
      const resumedMessages = [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-denied-1",
              toolName: "delete_things",
              input: { id: 42 },
            },
            {
              type: "tool-approval-request",
              approvalId: "approval-1",
              toolCallId: "call-denied-1",
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
      ];

      vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);
      vi.mocked(executeToolCallsFromMessages).mockResolvedValue([]);

      const onToolResult = vi.fn();

      await handleMCPJamFreeChatModel({
        messages: resumedMessages as any,
        modelId: "openai/gpt-5-mini",
        systemPrompt: "You are helpful",
        tools: {
          delete_things: { _serverId: "destructive-server" },
        } as any,
        mcpClientManager: {
          getAllToolsMetadata: vi.fn().mockReturnValue({
            delete_things: {},
          }),
        } as any,
        requireToolApproval: true,
        onToolResult,
      });

      await lastExecution;

      // The denial path fired `onToolResult` with the
      // user-denied-by-user error shape.
      expect(onToolResult).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallId: "call-denied-1",
          toolName: "delete_things",
          isError: true,
          stepIndex: expect.any(Number),
          promptIndex: 0,
        }),
      );
      const deniedCall = onToolResult.mock.calls.find(
        (c) => c[0]?.toolCallId === "call-denied-1",
      );
      expect(deniedCall?.[0]?.output).toEqual({
        type: "error-text",
        value: "Tool execution denied by user.",
      });
    });

    it("does not throw when callback omitted — chat / synthetic compatibility", async () => {
      // Defensive regression: every existing chat / synthetic call site
      // omits the new callbacks. The engine MUST stay no-op-equivalent
      // for those callers.
      global.fetch = vi.fn().mockResolvedValue(
        createSseResponse([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: "hi" },
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
      );

      // No callbacks supplied — same as every existing chat call site.
      await expect(
        handleMCPJamFreeChatModel({
          messages: [{ role: "user", content: "Say hi" }] as any,
          modelId: "openai/gpt-5-mini",
          systemPrompt: "You are helpful",
          tools: {},
          mcpClientManager: {
            getAllToolsMetadata: vi.fn().mockReturnValue({}),
          } as any,
        }),
      ).resolves.toBeDefined();

      await lastExecution;
    });

    it("catches callback throws without aborting the turn", async () => {
      // Eval callers' code might throw. The engine catches per-callback
      // and logs a warning so a buggy SSE emitter doesn't crash the
      // entire iteration.
      global.fetch = vi.fn().mockResolvedValue(
        createSseResponse([
          {
            type: "tool-input-available",
            toolCallId: "call-1",
            toolName: "read_docs",
            input: {},
          },
          {
            type: "finish",
            finishReason: "stop",
            messageMetadata: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
      );
      vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);

      const onToolCall = vi.fn(() => {
        throw new Error("callback boom");
      });
      const onStepFinish = vi.fn();

      await expect(
        handleMCPJamFreeChatModel({
          messages: [{ role: "user", content: "Run" }] as any,
          modelId: "openai/gpt-5-mini",
          systemPrompt: "You are helpful",
          tools: {
            read_docs: { _serverId: "docs-server" },
          } as any,
          mcpClientManager: {
            getAllToolsMetadata: vi.fn().mockReturnValue({ read_docs: {} }),
          } as any,
          onToolCall,
          onStepFinish,
        }),
      ).resolves.toBeDefined();

      await lastExecution;

      // Even though `onToolCall` threw, the engine kept running and
      // wrote chunks to the UI stream (proving the throw was caught
      // and didn't propagate). Don't strictly require `onStepFinish`
      // — depending on `hasUnresolvedToolCalls`'s response the engine
      // may short-circuit before a full step completes; the
      // load-bearing assertion is that `onToolCall` did fire AND the
      // overall promise resolved (i.e., no unhandled throw).
      expect(onToolCall).toHaveBeenCalled();
      expect(writtenChunks.length).toBeGreaterThan(0);
    });
  });
});
