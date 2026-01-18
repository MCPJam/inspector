import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMockMcpClientManager,
  createTestApp,
  postJson,
  expectJson,
  type MockMCPClientManager,
} from "./helpers/index.js";
import type { Hono } from "hono";

// Mock the AI SDK
vi.mock("ai", () => ({
  convertToModelMessages: vi.fn((messages) => messages),
  streamText: vi.fn().mockReturnValue({
    toUIMessageStreamResponse: vi.fn().mockReturnValue(
      new Response(JSON.stringify({ type: "text", content: "Hello" }), {
        headers: { "Content-Type": "text/event-stream" },
      })
    ),
  }),
  stepCountIs: vi.fn().mockReturnValue(() => false),
  createUIMessageStream: vi.fn(),
  createUIMessageStreamResponse: vi.fn(),
}));

// Mock chat helpers
vi.mock("../../../utils/chat-helpers", () => ({
  createLlmModel: vi.fn().mockReturnValue({}),
}));

// Mock shared types
vi.mock("@/shared/types", () => ({
  isGPT5Model: vi.fn().mockReturnValue(false),
  isMCPJamProvidedModel: vi.fn().mockReturnValue(false),
}));

describe("POST /api/mcp/chat-v2", () => {
  let manager: MockMCPClientManager;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
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
        })
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
        })
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
        })
      );
    });
  });

  describe("error handling", () => {
    it("returns 500 when getToolsForAiSdk fails", async () => {
      manager.getToolsForAiSdk.mockRejectedValue(new Error("Tools fetch failed"));

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
});
