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

// Mock the AI SDK
vi.mock("ai", () => ({
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
    execute({ writer: mockWriter });
    return { getReader: vi.fn() };
  }),
  createUIMessageStreamResponse: vi.fn().mockReturnValue(
    new Response(JSON.stringify({ type: "stream" }), {
      headers: { "Content-Type": "text/event-stream" },
    }),
  ),
}));

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
      expect(manager.getToolsForAiSdk).toHaveBeenCalledWith([
        "server-1",
        "server-2",
      ]);
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
      vi.mocked(hasUnresolvedToolCalls).mockReturnValue(true);
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

      // Mock fetch for CONVEX_HTTP_URL
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [],
          finishReason: "stop",
        }),
      });

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
          model: { id: "google/gemini-2.5-flash-preview", provider: "google" },
        });

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
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [],
          finishReason: "stop",
        }),
      });

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
          model: { id: "google/gemini-2.5-flash-preview", provider: "google" },
        });

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

      vi.mocked(hasUnresolvedToolCalls).mockReturnValue(true);
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

      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          messages: [],
          finishReason: "stop",
        }),
      });

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
          model: { id: "google/gemini-2.5-flash-preview", provider: "google" },
        });

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
          return {
            ok: true,
            json: async () => ({
              ok: true,
              messages: [
                {
                  role: "assistant",
                  content: [
                    {
                      type: "tool-call",
                      toolCallId: "new-call-from-step",
                      toolName: "new_tool",
                      input: { foo: "bar" },
                    },
                  ],
                },
              ],
              finishReason: "tool-calls",
            }),
          };
        }
        // Second call: return final response
        return {
          ok: true,
          json: async () => ({
            ok: true,
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Done!" }],
              },
            ],
            finishReason: "stop",
          }),
        };
      });

      try {
        await postJson(app, "/api/mcp/chat-v2", {
          // No inherited tool calls - clean message history
          messages: [{ role: "user", content: "Do something" }],
          model: { id: "google/gemini-2.5-flash-preview", provider: "google" },
        });

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
  });
});
