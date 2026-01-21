import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TestAgent, type TestAgentOptions } from "./test-agent.js";
import { MCPClientManager } from "../mcp-client-manager/index.js";
import type { ToolSet } from "ai";

// Mock the model factory
vi.mock("./model-factory.js", () => ({
  createModelFromString: vi.fn().mockReturnValue({
    provider: "openai",
    modelId: "gpt-4o",
  }),
}));

// Mock generateText from AI SDK
vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

import { generateText } from "ai";

describe("TestAgent", () => {
  const mockGenerateText = generateText as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("creates instance with ToolSet", () => {
      const mockToolSet: ToolSet = {
        create_task: {
          description: "Create a task",
          parameters: { type: "object", properties: {} },
          execute: vi.fn(),
        },
      };

      const agent = new TestAgent({
        tools: mockToolSet,
        llm: "openai/gpt-4o",
        apiKey: "test-key",
      });

      expect(agent).toBeInstanceOf(TestAgent);
      expect(agent.config.llm).toBe("openai/gpt-4o");
    });

    it("creates instance with MCPClientManager", () => {
      const mockManager = Object.create(MCPClientManager.prototype);
      mockManager.getToolsForAiSdk = vi.fn().mockResolvedValue({});

      const agent = new TestAgent({
        tools: mockManager,
        serverIds: ["asana"],
        llm: "anthropic/claude-3-opus",
        apiKey: "test-key",
        systemPrompt: "You are helpful.",
        temperature: 0.7,
      });

      expect(agent).toBeInstanceOf(TestAgent);
      expect(agent.config.serverIds).toEqual(["asana"]);
      expect(agent.config.systemPrompt).toBe("You are helpful.");
      expect(agent.config.temperature).toBe(0.7);
    });
  });

  describe("config getter", () => {
    it("returns current configuration", () => {
      const mockToolSet: ToolSet = {};
      const agent = new TestAgent({
        tools: mockToolSet,
        llm: "openai/gpt-4o",
        apiKey: "my-key",
        systemPrompt: "Test prompt",
        temperature: 0.5,
        maxTokens: 1000,
        serverIds: ["server1"],
      });

      const config = agent.config;

      expect(config).toEqual({
        llm: "openai/gpt-4o",
        apiKey: "my-key",
        systemPrompt: "Test prompt",
        temperature: 0.5,
        maxTokens: 1000,
        serverIds: ["server1"],
      });
    });
  });

  describe("withOptions", () => {
    it("creates new agent with overridden options", () => {
      const mockToolSet: ToolSet = {};
      const originalAgent = new TestAgent({
        tools: mockToolSet,
        llm: "openai/gpt-4o",
        apiKey: "key",
        temperature: 0.7,
      });

      const newAgent = originalAgent.withOptions({
        temperature: 0.2,
        systemPrompt: "New prompt",
      });

      expect(newAgent).not.toBe(originalAgent);
      expect(newAgent.config.temperature).toBe(0.2);
      expect(newAgent.config.systemPrompt).toBe("New prompt");
      expect(newAgent.config.llm).toBe("openai/gpt-4o");
    });
  });

  describe("query", () => {
    it("returns QueryResult on successful query", async () => {
      const mockToolSet: ToolSet = {};
      const agent = new TestAgent({
        tools: mockToolSet,
        llm: "openai/gpt-4o",
        apiKey: "test-key",
      });

      mockGenerateText.mockResolvedValueOnce({
        text: "I created a task for you.",
        steps: [
          {
            toolCalls: [
              { toolName: "create_task", args: { title: "My Task" } },
            ],
          },
        ],
        usage: {
          inputTokens: 100,
          outputTokens: 200,
          totalTokens: 300,
        },
      });

      const result = await agent.query("Create a task called My Task");

      expect(result.query).toBe("Create a task called My Task");
      expect(result.response).toBe("I created a task for you.");
      expect(result.success).toBe(true);
      expect(result.toolsCalled()).toEqual(["create_task"]);
      expect(result.totalTokens()).toBe(300);
      expect(result.e2eLatencyMs).toBeGreaterThan(0);
    });

    it("includes system prompt in messages", async () => {
      const mockToolSet: ToolSet = {};
      const agent = new TestAgent({
        tools: mockToolSet,
        llm: "openai/gpt-4o",
        apiKey: "test-key",
        systemPrompt: "You are a helpful assistant.",
      });

      mockGenerateText.mockResolvedValueOnce({
        text: "Response",
        steps: [],
        usage: {},
      });

      await agent.query("Hello");

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: "Hello" },
          ],
        }),
      );
    });

    it("allows per-query system prompt override", async () => {
      const mockToolSet: ToolSet = {};
      const agent = new TestAgent({
        tools: mockToolSet,
        llm: "openai/gpt-4o",
        apiKey: "test-key",
        systemPrompt: "Original prompt",
      });

      mockGenerateText.mockResolvedValueOnce({
        text: "Response",
        steps: [],
        usage: {},
      });

      await agent.query("Hello", { systemPrompt: "Override prompt" });

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: "system", content: "Override prompt" },
            { role: "user", content: "Hello" },
          ],
        }),
      );
    });

    it("handles temperature from config", async () => {
      const mockToolSet: ToolSet = {};
      const agent = new TestAgent({
        tools: mockToolSet,
        llm: "openai/gpt-4o",
        apiKey: "test-key",
        temperature: 0.8,
      });

      mockGenerateText.mockResolvedValueOnce({
        text: "Response",
        steps: [],
        usage: {},
      });

      await agent.query("Hello");

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.8,
        }),
      );
    });

    it("handles per-query temperature override", async () => {
      const mockToolSet: ToolSet = {};
      const agent = new TestAgent({
        tools: mockToolSet,
        llm: "openai/gpt-4o",
        apiKey: "test-key",
        temperature: 0.8,
      });

      mockGenerateText.mockResolvedValueOnce({
        text: "Response",
        steps: [],
        usage: {},
      });

      await agent.query("Hello", { temperature: 0.2 });

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.2,
        }),
      );
    });

    it("returns error result when query fails", async () => {
      const mockToolSet: ToolSet = {};
      const agent = new TestAgent({
        tools: mockToolSet,
        llm: "openai/gpt-4o",
        apiKey: "test-key",
      });

      mockGenerateText.mockRejectedValueOnce(
        new Error("API rate limit exceeded"),
      );

      const result = await agent.query("Hello");

      expect(result.success).toBe(false);
      expect(result.error).toBe("API rate limit exceeded");
      expect(result.response).toBe("");
      expect(result.toolsCalled()).toEqual([]);
    });

    it("uses MCPClientManager to get tools", async () => {
      const mockManager = Object.create(MCPClientManager.prototype);
      const mockToolSet: ToolSet = {
        my_tool: {
          description: "Test tool",
          parameters: { type: "object", properties: {} },
          execute: vi.fn(),
        },
      };
      mockManager.getToolsForAiSdk = vi.fn().mockResolvedValue(mockToolSet);

      const agent = new TestAgent({
        tools: mockManager,
        serverIds: ["server1", "server2"],
        llm: "openai/gpt-4o",
        apiKey: "test-key",
      });

      mockGenerateText.mockResolvedValueOnce({
        text: "Response",
        steps: [],
        usage: {},
      });

      await agent.query("Hello");

      expect(mockManager.getToolsForAiSdk).toHaveBeenCalledWith([
        "server1",
        "server2",
      ]);
      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: mockToolSet,
        }),
      );
    });

    it("passes stopWhen function for maxSteps option", async () => {
      const mockToolSet: ToolSet = {};
      const agent = new TestAgent({
        tools: mockToolSet,
        llm: "openai/gpt-4o",
        apiKey: "test-key",
      });

      mockGenerateText.mockResolvedValueOnce({
        text: "Response",
        steps: [],
        usage: {},
      });

      await agent.query("Hello", { maxSteps: 10 });

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          stopWhen: expect.any(Function),
        }),
      );
    });

    it("uses stopWhen function by default", async () => {
      const mockToolSet: ToolSet = {};
      const agent = new TestAgent({
        tools: mockToolSet,
        llm: "openai/gpt-4o",
        apiKey: "test-key",
      });

      mockGenerateText.mockResolvedValueOnce({
        text: "Response",
        steps: [],
        usage: {},
      });

      await agent.query("Hello");

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          stopWhen: expect.any(Function),
        }),
      );
    });

    it("handles multi-step tool calls", async () => {
      const mockToolSet: ToolSet = {};
      const agent = new TestAgent({
        tools: mockToolSet,
        llm: "openai/gpt-4o",
        apiKey: "test-key",
      });

      mockGenerateText.mockResolvedValueOnce({
        text: "I searched and updated the task.",
        steps: [
          { toolCalls: [{ toolName: "search_tasks", args: { query: "bug" } }] },
          {
            toolCalls: [
              { toolName: "update_task", args: { id: "123", status: "done" } },
            ],
          },
        ],
        usage: {
          promptTokens: 200,
          completionTokens: 400,
          totalTokens: 600,
        },
      });

      const result = await agent.query("Find and close the bug task");

      expect(result.toolsCalled()).toEqual(["search_tasks", "update_task"]);
      expect(result.toolCallCount()).toBe(2);
      expect(result.hasToolCall("search_tasks")).toBe(true);
      expect(result.hasToolCall("update_task")).toBe(true);
    });
  });
});
