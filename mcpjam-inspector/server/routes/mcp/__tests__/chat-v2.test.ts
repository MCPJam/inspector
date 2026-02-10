import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMockMcpClientManager,
  createTestApp,
  postJson,
  expectJson,
  type MockMCPClientManager,
} from "./helpers/index.js";
import type { Hono } from "hono";

// Track stream events for testing
let capturedStreamEvents: any[] = [];
let mockWriter: { write: ReturnType<typeof vi.fn> };
let lastStreamExecution: Promise<void> | null = null;

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

// Mock the AI SDK
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    convertToModelMessages: vi.fn((messages) => messages),
    streamText: vi.fn().mockReturnValue({
      toUIMessageStreamResponse: vi.fn().mockReturnValue(
        new Response(JSON.stringify({ type: "text", content: "Hello" }), {
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
    }),
    stepCountIs: vi.fn().mockReturnValue(() => false),
    createUIMessageStream: vi.fn(({ execute }) => {
      // Create a mock writer that captures events
      mockWriter = {
        write: vi.fn((event) => {
          capturedStreamEvents.push(event);
        }),
      };
      // Execute the stream function to capture events
      const execResult = execute({ writer: mockWriter });
      lastStreamExecution =
        execResult instanceof Promise ? execResult : Promise.resolve();
      return { getReader: vi.fn() };
    }),
    createUIMessageStreamResponse: vi.fn().mockReturnValue(
      new Response(JSON.stringify({ type: "stream" }), {
        headers: { "Content-Type": "text/event-stream" },
      }),
    ),
  };
});

// Mock chat helpers
vi.mock("../../../utils/chat-helpers", () => ({
  createLlmModel: vi.fn().mockReturnValue({}),
  scrubMcpAppsToolResultsForBackend: vi.fn((messages) => messages),
  scrubChatGPTAppsToolResultsForBackend: vi.fn((messages) => messages),
}));

// Mock shared types
vi.mock("@/shared/types", () => ({
  isGPT5Model: vi.fn().mockReturnValue(false),
  isMCPJamProvidedModel: vi.fn().mockReturnValue(false),
}));

// Mock http-tool-calls for testing unresolved tool calls scenario
vi.mock("@/shared/http-tool-calls", () => ({
  hasUnresolvedToolCalls: vi.fn().mockReturnValue(false),
  executeToolCallsFromMessages: vi.fn(),
}));

// Mock skill-tools to avoid file system operations
vi.mock("../../../utils/skill-tools", () => ({
  getSkillToolsAndPrompt: vi.fn().mockResolvedValue({
    tools: {},
    systemPromptSection: "",
  }),
}));

describe("POST /api/mcp/chat-v2", () => {
  let manager: MockMCPClientManager;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedStreamEvents = [];
    lastStreamExecution = null;
    manager = createMockMcpClientManager({
      getToolsForAiSdk: vi.fn().mockResolvedValue({}),
    });
    app = createTestApp(manager, "chat-v2");
  });

  describe("validation", () => {
    it("returns 400 when messages is missing", async () => {
      const res = await postJson(app, "/api/mcp/chat-v2", {
        model: { id: "gpt-4", provider: "openai" },
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(400);
      expect(data.error).toBe("messages are required");
    });

    it("returns 400 when messages is empty array", async () => {
      const res = await postJson(app, "/api/mcp/chat-v2", {
        messages: [],
        model: { id: "gpt-4", provider: "openai" },
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(400);
      expect(data.error).toBe("messages are required");
    });

    it("returns 400 when messages is not an array", async () => {
      const res = await postJson(app, "/api/mcp/chat-v2", {
        messages: "not an array",
        model: { id: "gpt-4", provider: "openai" },
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(400);
      expect(data.error).toBe("messages are required");
    });

    it("returns 400 when model is missing", async () => {
      const res = await postJson(app, "/api/mcp/chat-v2", {
        messages: [{ role: "user", content: "Hello" }],
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(400);
      expect(data.error).toBe("model is not supported");
    });
  });

  describe("success cases", () => {
    it("calls getToolsForAiSdk with selected servers", async () => {
      const res = await postJson(app, "/api/mcp/chat-v2", {
        messages: [{ role: "user", content: "Hello" }],
        model: { id: "gpt-4", provider: "openai" },
        apiKey: "test-key",
        selectedServers: ["server-1", "server-2"],
      });

      expect(res.status).toBe(200);
      expect(manager.getToolsForAiSdk).toHaveBeenCalledWith(
        ["server-1", "server-2"],
        undefined,
      );
    });

    it("returns streaming response", async () => {
      const res = await postJson(app, "/api/mcp/chat-v2", {
        messages: [{ role: "user", content: "Hello" }],
        model: { id: "gpt-4", provider: "openai" },
        apiKey: "test-key",
      });

      expect(res.status).toBe(200);
      // Streaming responses have specific content type
      expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    });

    it("uses provided temperature", async () => {
      const { streamText } = await import("ai");

      await postJson(app, "/api/mcp/chat-v2", {
        messages: [{ role: "user", content: "Hello" }],
        model: { id: "gpt-4", provider: "openai" },
        apiKey: "test-key",
        temperature: 0.5,
      });

      expect(streamText).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.5,
        }),
      );
    });

    it("uses default temperature when not provided", async () => {
      const { streamText } = await import("ai");

      await postJson(app, "/api/mcp/chat-v2", {
        messages: [{ role: "user", content: "Hello" }],
        model: { id: "gpt-4", provider: "openai" },
        apiKey: "test-key",
      });

      expect(streamText).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.7,
        }),
      );
    });

    it("includes system prompt when provided", async () => {
      const { streamText } = await import("ai");

      await postJson(app, "/api/mcp/chat-v2", {
        messages: [{ role: "user", content: "Hello" }],
        model: { id: "gpt-4", provider: "openai" },
        apiKey: "test-key",
        systemPrompt: "You are a helpful assistant",
      });

      expect(streamText).toHaveBeenCalledWith(
        expect.objectContaining({
          system: "You are a helpful assistant",
        }),
      );
    });
  });

  describe("error handling", () => {
    it("returns 500 when getToolsForAiSdk fails", async () => {
      manager.getToolsForAiSdk.mockRejectedValue(
        new Error("Tools fetch failed"),
      );

      const res = await postJson(app, "/api/mcp/chat-v2", {
        messages: [{ role: "user", content: "Hello" }],
        model: { id: "gpt-4", provider: "openai" },
        apiKey: "test-key",
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(500);
      expect(data.error).toBe("Unexpected error");
    });
  });

  describe("multi-turn conversations", () => {
    it("handles conversation with multiple messages", async () => {
      const res = await postJson(app, "/api/mcp/chat-v2", {
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi there!" },
          { role: "user", content: "How are you?" },
        ],
        model: { id: "gpt-4", provider: "openai" },
        apiKey: "test-key",
      });

      expect(res.status).toBe(200);
    });

    it("handles messages with tool calls", async () => {
      const res = await postJson(app, "/api/mcp/chat-v2", {
        messages: [
          { role: "user", content: "Read the file test.txt" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "call-1",
                name: "read_file",
                args: { path: "test.txt" },
              },
            ],
          },
          {
            role: "tool",
            content: "File contents here",
            toolCallId: "call-1",
          },
        ],
        model: { id: "gpt-4", provider: "openai" },
        apiKey: "test-key",
      });

      expect(res.status).toBe(200);
    });
  });

  describe("unresolved tool calls from aborted requests (MCPJam models)", () => {
    beforeEach(async () => {
      // Enable MCPJam model path
      const { isMCPJamProvidedModel } = await import("@/shared/types");
      vi.mocked(isMCPJamProvidedModel).mockReturnValue(true);

      // Set required env var
      process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    });

    afterEach(() => {
      delete process.env.CONVEX_HTTP_URL;
    });

    it("emits tool-input-available before tool-output-available for inherited unresolved tool calls", async () => {
      const { hasUnresolvedToolCalls, executeToolCallsFromMessages } =
        await import("@/shared/http-tool-calls");

      // Setup: message history has an unresolved tool call (simulating abort scenario)
      // First check: unresolved (inherited tool call), second check: resolved after execution
      let hasUnresolvedCallCount = 0;
      vi.mocked(hasUnresolvedToolCalls).mockImplementation(() => {
        hasUnresolvedCallCount++;
        return hasUnresolvedCallCount === 1;
      });
      vi.mocked(executeToolCallsFromMessages).mockImplementation(
        async (messages: any[]) => {
          // Simulate adding tool result to messages
          messages.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "orphaned-call-123",
                output: { type: "json", value: { result: "executed" } },
              },
            ],
          });
        },
      );

      // Mock fetch for CONVEX_HTTP_URL - return fresh response each time
      const originalFetch = global.fetch;
      const finishEvents = [
        {
          type: "finish",
          finishReason: "stop",
          messageMetadata: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        },
      ];
      global.fetch = vi
        .fn()
        .mockImplementation(async () => createSseResponse(finishEvents));

      try {
        await postJson(app, "/api/mcp/chat-v2", {
          messages: [
            { role: "user", content: "Continue" },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "orphaned-call-123",
                  toolName: "asana_list_workspaces",
                  input: {},
                },
              ],
            },
          ],
          model: { id: "google/gemini-2.5-flash", provider: "google" },
        });
        await lastStreamExecution;

        // Find tool-input-available and tool-output-available events
        const toolInputEvents = capturedStreamEvents.filter(
          (e) => e.type === "tool-input-available",
        );
        const toolOutputEvents = capturedStreamEvents.filter(
          (e) => e.type === "tool-output-available",
        );

        // Verify tool-input-available was emitted for the orphaned tool call
        expect(toolInputEvents.length).toBeGreaterThanOrEqual(1);
        expect(
          toolInputEvents.some((e) => e.toolCallId === "orphaned-call-123"),
        ).toBe(true);

        // Verify tool-output-available was also emitted
        expect(toolOutputEvents.length).toBeGreaterThanOrEqual(1);
        expect(
          toolOutputEvents.some((e) => e.toolCallId === "orphaned-call-123"),
        ).toBe(true);

        // Verify order: tool-input-available must come before tool-output-available
        const inputIndex = capturedStreamEvents.findIndex(
          (e) =>
            e.type === "tool-input-available" &&
            e.toolCallId === "orphaned-call-123",
        );
        const outputIndex = capturedStreamEvents.findIndex(
          (e) =>
            e.type === "tool-output-available" &&
            e.toolCallId === "orphaned-call-123",
        );

        expect(inputIndex).toBeLessThan(outputIndex);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("does not emit duplicate tool-input-available for tool calls that already have results", async () => {
      const { hasUnresolvedToolCalls, executeToolCallsFromMessages } =
        await import("@/shared/http-tool-calls");

      // No unresolved tool calls - all are resolved
      vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);
      vi.mocked(executeToolCallsFromMessages).mockImplementation(
        async () => {},
      );

      // Mock fetch for CONVEX_HTTP_URL
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue(
        createSseResponse([
          {
            type: "finish",
            finishReason: "stop",
            messageMetadata: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
            },
          },
        ]),
      );

      try {
        await postJson(app, "/api/mcp/chat-v2", {
          messages: [
            { role: "user", content: "Continue" },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "resolved-call-456",
                  toolName: "some_tool",
                  input: {},
                },
              ],
            },
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "resolved-call-456",
                  output: { result: "already done" },
                },
              ],
            },
          ],
          model: { id: "google/gemini-2.5-flash", provider: "google" },
        });
        await lastStreamExecution;

        // Should NOT emit tool-input-available for already-resolved tool calls
        const toolInputEvents = capturedStreamEvents.filter(
          (e) =>
            e.type === "tool-input-available" &&
            e.toolCallId === "resolved-call-456",
        );

        expect(toolInputEvents.length).toBe(0);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("handles multiple unresolved tool calls from aborted request", async () => {
      const { hasUnresolvedToolCalls, executeToolCallsFromMessages } =
        await import("@/shared/http-tool-calls");

      // First check: unresolved (inherited tool calls), second check: resolved after execution
      let hasUnresolvedCallCount = 0;
      vi.mocked(hasUnresolvedToolCalls).mockImplementation(() => {
        hasUnresolvedCallCount++;
        return hasUnresolvedCallCount === 1;
      });
      vi.mocked(executeToolCallsFromMessages).mockImplementation(
        async (messages: any[]) => {
          // Simulate adding tool results for both calls
          messages.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                output: { type: "json", value: { result: "result1" } },
              },
            ],
          });
          messages.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-2",
                output: { type: "json", value: { result: "result2" } },
              },
            ],
          });
        },
      );

      // Mock fetch for CONVEX_HTTP_URL - return fresh response each time
      const originalFetch = global.fetch;
      const finishEvents = [
        {
          type: "finish",
          finishReason: "stop",
          messageMetadata: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        },
      ];
      global.fetch = vi
        .fn()
        .mockImplementation(async () => createSseResponse(finishEvents));

      try {
        await postJson(app, "/api/mcp/chat-v2", {
          messages: [
            { role: "user", content: "Do two things" },
            {
              role: "assistant",
              content: [
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "tool_a",
                  input: { arg: "a" },
                },
                {
                  type: "tool-call",
                  toolCallId: "call-2",
                  toolName: "tool_b",
                  input: { arg: "b" },
                },
              ],
            },
          ],
          model: { id: "google/gemini-2.5-flash", provider: "google" },
        });
        await lastStreamExecution;

        // Verify both tool calls get tool-input-available emitted
        const toolInputEvents = capturedStreamEvents.filter(
          (e) => e.type === "tool-input-available",
        );

        expect(toolInputEvents.some((e) => e.toolCallId === "call-1")).toBe(
          true,
        );
        expect(toolInputEvents.some((e) => e.toolCallId === "call-2")).toBe(
          true,
        );

        // Verify tool names and inputs are preserved
        const call1Event = toolInputEvents.find(
          (e) => e.toolCallId === "call-1",
        );
        const call2Event = toolInputEvents.find(
          (e) => e.toolCallId === "call-2",
        );

        expect(call1Event?.toolName).toBe("tool_a");
        expect(call1Event?.input).toEqual({ arg: "a" });
        expect(call2Event?.toolName).toBe("tool_b");
        expect(call2Event?.input).toEqual({ arg: "b" });
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("batches multiple tool calls from one stream response", async () => {
      const { hasUnresolvedToolCalls, executeToolCallsFromMessages } =
        await import("@/shared/http-tool-calls");

      // First call: has unresolved (the two new tool calls), second call: resolved after execution
      let hasUnresolvedCallCount = 0;
      vi.mocked(hasUnresolvedToolCalls).mockImplementation(() => {
        hasUnresolvedCallCount++;
        return hasUnresolvedCallCount === 1;
      });
      vi.mocked(executeToolCallsFromMessages).mockImplementation(
        async (messages: any[]) => {
          messages.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "batch-call-1",
                output: { type: "json", value: { stops: ["Berryessa"] } },
              },
            ],
          });
          messages.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "batch-call-2",
                output: { type: "json", value: { stops: ["Montgomery"] } },
              },
            ],
          });
        },
      );

      const originalFetch = global.fetch;
      let fetchCallCount = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          // Backend sends TWO tool calls + finish in a single SSE response
          return createSseResponse([
            {
              type: "tool-input-available",
              toolCallId: "batch-call-1",
              toolName: "search_stops",
              input: { query: "Berryessa" },
            },
            {
              type: "tool-input-available",
              toolCallId: "batch-call-2",
              toolName: "search_stops",
              input: { query: "Montgomery" },
            },
            {
              type: "finish",
              finishReason: "tool-calls",
              messageMetadata: {
                inputTokens: 10,
                outputTokens: 20,
                totalTokens: 30,
              },
            },
          ]);
        }
        // Second fetch: final text response after tool results
        return createSseResponse([
          { type: "text-start", id: "msg-1" },
          {
            type: "text-delta",
            id: "msg-1",
            delta: "Found Berryessa and Montgomery.",
          },
          { type: "text-end", id: "msg-1" },
          {
            type: "finish",
            finishReason: "stop",
            messageMetadata: {
              inputTokens: 30,
              outputTokens: 10,
              totalTokens: 40,
            },
          },
        ]);
      });

      try {
        await postJson(app, "/api/mcp/chat-v2", {
          messages: [
            { role: "user", content: "Search stops Berryessa and Montgomery" },
          ],
          model: { id: "google/gemini-2.5-flash", provider: "google" },
        });
        await lastStreamExecution;

        // Both tool calls should be collected from a single fetch
        const toolInputEvents = capturedStreamEvents.filter(
          (e) => e.type === "tool-input-available",
        );
        expect(
          toolInputEvents.some((e) => e.toolCallId === "batch-call-1"),
        ).toBe(true);
        expect(
          toolInputEvents.some((e) => e.toolCallId === "batch-call-2"),
        ).toBe(true);

        // Both tool results should be emitted
        const toolOutputEvents = capturedStreamEvents.filter(
          (e) => e.type === "tool-output-available",
        );
        expect(
          toolOutputEvents.some((e) => e.toolCallId === "batch-call-1"),
        ).toBe(true);
        expect(
          toolOutputEvents.some((e) => e.toolCallId === "batch-call-2"),
        ).toBe(true);

        // Only 2 fetch calls total (one for tool calls batch, one for final response)
        expect(fetchCallCount).toBe(2);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("does not emit duplicate tool-input-available for new tool calls from current step", async () => {
      const { hasUnresolvedToolCalls, executeToolCallsFromMessages } =
        await import("@/shared/http-tool-calls");

      // First call returns true (new tool call needs execution), then false after result added
      let hasUnresolvedCallCount = 0;
      vi.mocked(hasUnresolvedToolCalls).mockImplementation(() => {
        hasUnresolvedCallCount++;
        // First call: true (new tool call needs execution)
        // Second call: false (tool result added, no more unresolved)
        return hasUnresolvedCallCount === 1;
      });
      vi.mocked(executeToolCallsFromMessages).mockImplementation(
        async (messages: any[]) => {
          // Simulate adding tool result for the new tool call
          messages.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "new-call-from-step",
                output: { type: "json", value: { result: "done" } },
              },
            ],
          });
        },
      );

      const originalFetch = global.fetch;
      let fetchCallCount = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          // First call: return a new tool call
          return createSseResponse([
            {
              type: "tool-input-available",
              toolCallId: "new-call-from-step",
              toolName: "new_tool",
              input: { foo: "bar" },
            },
          ]);
        }
        // Second call: return final response
        return createSseResponse([
          { type: "text-start", id: "msg-1" },
          { type: "text-delta", id: "msg-1", delta: "Done!" },
          { type: "text-end", id: "msg-1" },
          {
            type: "finish",
            finishReason: "stop",
            messageMetadata: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
            },
          },
        ]);
      });

      try {
        await postJson(app, "/api/mcp/chat-v2", {
          // No inherited tool calls - clean message history
          messages: [{ role: "user", content: "Do something" }],
          model: { id: "google/gemini-2.5-flash", provider: "google" },
        });
        await lastStreamExecution;

        // Count how many times tool-input-available was emitted for this tool call
        const toolInputEventsForNewCall = capturedStreamEvents.filter(
          (e) =>
            e.type === "tool-input-available" &&
            e.toolCallId === "new-call-from-step",
        );

        // Should be emitted exactly ONCE (when processing json.messages),
        // NOT twice (which would happen if the unresolved tool calls logic also emitted it)
        expect(toolInputEventsForNewCall.length).toBe(1);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("normalizes duplicate tool call IDs across MCPJam stream steps", async () => {
      const { hasUnresolvedToolCalls, executeToolCallsFromMessages } =
        await import("@/shared/http-tool-calls");

      let unresolvedChecks = 0;
      vi.mocked(hasUnresolvedToolCalls).mockImplementation(() => {
        unresolvedChecks++;
        // Step 1 and step 2 produce tool calls; step 3 is final text.
        return unresolvedChecks <= 2;
      });

      vi.mocked(executeToolCallsFromMessages).mockImplementation(
        async (messages: any[]) => {
          const latestAssistantWithToolCall = [...messages]
            .reverse()
            .find(
              (msg) =>
                msg?.role === "assistant" &&
                Array.isArray(msg.content) &&
                msg.content.some((part: any) => part?.type === "tool-call"),
            );

          const latestToolCall = latestAssistantWithToolCall?.content?.find(
            (part: any) => part?.type === "tool-call",
          );

          if (!latestToolCall?.toolCallId) return;

          messages.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: latestToolCall.toolCallId,
                output: { type: "json", value: { ok: true } },
              },
            ],
          });
        },
      );

      const originalFetch = global.fetch;
      let fetchCallCount = 0;
      global.fetch = vi.fn().mockImplementation(async () => {
        fetchCallCount++;

        if (fetchCallCount <= 2) {
          return createSseResponse([
            {
              type: "tool-input-available",
              toolCallId: "dup-call",
              toolName: "create_view",
              input: { step: fetchCallCount },
            },
            {
              type: "finish",
              finishReason: "tool-calls",
              messageMetadata: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            },
          ]);
        }

        return createSseResponse([
          { type: "text-start", id: "msg-final" },
          { type: "text-delta", id: "msg-final", delta: "Done" },
          { type: "text-end", id: "msg-final" },
          {
            type: "finish",
            finishReason: "stop",
            messageMetadata: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
            },
          },
        ]);
      });

      try {
        await postJson(app, "/api/mcp/chat-v2", {
          messages: [{ role: "user", content: "Do two create_view calls" }],
          model: { id: "google/gemini-2.5-flash-preview", provider: "google" },
        });
        await lastStreamExecution;

        const toolInputEvents = capturedStreamEvents.filter(
          (e) => e.type === "tool-input-available",
        );
        const toolOutputEvents = capturedStreamEvents.filter(
          (e) => e.type === "tool-output-available",
        );

        expect(fetchCallCount).toBe(3);
        expect(toolInputEvents).toHaveLength(2);
        expect(toolOutputEvents).toHaveLength(2);

        const firstToolCallId = toolInputEvents[0]?.toolCallId;
        const secondToolCallId = toolInputEvents[1]?.toolCallId;

        expect(firstToolCallId).toBe("dup-call");
        expect(secondToolCallId).not.toBe("dup-call");
        expect(secondToolCallId).toMatch(/dup-call__s2_/);

        expect(
          toolOutputEvents.some((e) => e.toolCallId === firstToolCallId),
        ).toBe(true);
        expect(
          toolOutputEvents.some((e) => e.toolCallId === secondToolCallId),
        ).toBe(true);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
