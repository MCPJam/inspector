import { TestAgent } from "../src/TestAgent";
import { PromptResult } from "../src/PromptResult";
import type { ToolSet } from "ai";
import type { Tool } from "../src/mcp-client-manager/types";

// Mock the ai module
jest.mock("ai", () => ({
  generateText: jest.fn(),
  stepCountIs: jest.fn((n: number) => ({ type: "stepCount", value: n })),
  dynamicTool: jest.fn((config: any) => ({
    ...config,
    type: "dynamic",
  })),
  jsonSchema: jest.fn((schema: any) => schema),
}));

// Mock the model factory
jest.mock("../src/model-factory", () => ({
  createModelFromString: jest.fn(() => ({})),
}));

import { generateText, jsonSchema } from "ai";
import { createModelFromString } from "../src/model-factory";

const mockGenerateText = generateText as jest.MockedFunction<
  typeof generateText
>;
const mockCreateModel = createModelFromString as jest.MockedFunction<
  typeof createModelFromString
>;

describe("TestAgent", () => {
  // Create a mock ToolSet for testing
  const mockToolSet: ToolSet = {
    add: {
      description: "Add two numbers",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
      }),
      execute: async (args: { a: number; b: number }) => args.a + args.b,
    },
    subtract: {
      description: "Subtract two numbers",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
        },
        required: ["a", "b"],
      }),
      execute: async (args: { a: number; b: number }) => args.a - args.b,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("constructor", () => {
    it("should create an instance with config", () => {
      const agent = new TestAgent({
        tools: {},
        model: "openai/gpt-4o",
        apiKey: "test-api-key",
      });

      expect(agent).toBeInstanceOf(TestAgent);
    });

    it("should accept optional parameters", () => {
      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-api-key",
        systemPrompt: "You are a test assistant.",
        temperature: 0.5,
        maxSteps: 5,
      });

      expect(agent).toBeInstanceOf(TestAgent);
      expect(agent.getSystemPrompt()).toBe("You are a test assistant.");
      expect(agent.getTemperature()).toBe(0.5);
      expect(agent.getMaxSteps()).toBe(5);
    });

    it("should use default values for optional parameters", () => {
      const agent = new TestAgent({
        tools: {},
        model: "openai/gpt-4o",
        apiKey: "test-api-key",
      });

      expect(agent.getSystemPrompt()).toBe("You are a helpful assistant.");
      expect(agent.getTemperature()).toBe(undefined);
      expect(agent.getMaxSteps()).toBe(10);
    });
  });

  describe("configuration", () => {
    it("should return the configured tools", () => {
      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-api-key",
      });

      expect(agent.getTools()).toBe(mockToolSet);
    });

    it("should return the configured LLM", () => {
      const agent = new TestAgent({
        tools: {},
        model: "anthropic/claude-3-5-sonnet-20241022",
        apiKey: "test-api-key",
      });

      expect(agent.getModel()).toBe("anthropic/claude-3-5-sonnet-20241022");
    });

    it("should return the configured API key", () => {
      const agent = new TestAgent({
        tools: {},
        model: "openai/gpt-4o",
        apiKey: "my-secret-key",
      });

      expect(agent.getApiKey()).toBe("my-secret-key");
    });

    it("should update system prompt", () => {
      const agent = new TestAgent({
        tools: {},
        model: "openai/gpt-4o",
        apiKey: "test-api-key",
      });

      agent.setSystemPrompt("New prompt");
      expect(agent.getSystemPrompt()).toBe("New prompt");
    });

    it("should validate temperature range", () => {
      const agent = new TestAgent({
        tools: {},
        model: "openai/gpt-4o",
        apiKey: "test-api-key",
      });

      expect(() => agent.setTemperature(0.5)).not.toThrow();
      expect(agent.getTemperature()).toBe(0.5);

      expect(() => agent.setTemperature(0)).not.toThrow();
      expect(agent.getTemperature()).toBe(0);

      expect(() => agent.setTemperature(2)).not.toThrow();
      expect(agent.getTemperature()).toBe(2);

      expect(() => agent.setTemperature(-1)).toThrow(
        "Temperature must be between 0 and 2"
      );
      expect(() => agent.setTemperature(3)).toThrow(
        "Temperature must be between 0 and 2"
      );
    });
  });

  describe("prompt()", () => {
    it("should return a PromptResult on success", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "The result is 5",
        steps: [
          {
            toolCalls: [{ toolName: "add", args: { a: 2, b: 3 } }],
          },
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      } as any);

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-api-key",
      });

      const result = await agent.prompt("Add 2 and 3");

      expect(result).toBeInstanceOf(PromptResult);
      expect(result.text).toBe("The result is 5");
      expect(result.toolsCalled()).toEqual(["add"]);
      expect(result.hasError()).toBe(false);
      expect(result.inputTokens()).toBe(10);
      expect(result.outputTokens()).toBe(5);
      expect(result.totalTokens()).toBe(15);
      expect(result.e2eLatencyMs()).toBeGreaterThanOrEqual(0);
      expect(result.llmLatencyMs()).toBeGreaterThanOrEqual(0);
      expect(result.mcpLatencyMs()).toBeGreaterThanOrEqual(0);
    });

    it("should extract tool calls from result steps", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "Done",
        steps: [
          {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "1",
                toolName: "add",
                input: { a: 1, b: 2 },
              },
            ],
          },
          {
            toolCalls: [
              {
                type: "tool-call",
                toolCallId: "2",
                toolName: "subtract",
                input: { a: 5, b: 3 },
              },
            ],
          },
        ],
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      } as any);

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-api-key",
      });

      const result = await agent.prompt("Do some math");

      expect(result.toolsCalled()).toEqual(["add", "subtract"]);
      expect(result.getToolCalls()).toHaveLength(2);
      expect(result.getToolCalls()[0]).toEqual({
        toolName: "add",
        arguments: { a: 1, b: 2 },
      });
      expect(result.getToolCalls()[1]).toEqual({
        toolName: "subtract",
        arguments: { a: 5, b: 3 },
      });
    });

    it("should return error result on LLM failure", async () => {
      mockGenerateText.mockRejectedValueOnce(
        new Error("API rate limit exceeded")
      );

      const agent = new TestAgent({
        tools: {},
        model: "openai/gpt-4o",
        apiKey: "test-api-key",
      });

      const result = await agent.prompt("Test prompt");

      expect(result).toBeInstanceOf(PromptResult);
      expect(result.hasError()).toBe(true);
      expect(result.getError()).toBe("API rate limit exceeded");
      expect(result.text).toBe("");
      expect(result.toolsCalled()).toEqual([]);
      // Verify latency is tracked even on error
      expect(result.e2eLatencyMs()).toBeGreaterThanOrEqual(0);
    });

    it("should provide latency breakdown with getLatency()", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "Done",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const agent = new TestAgent({
        tools: {},
        model: "openai/gpt-4o",
        apiKey: "test-api-key",
      });

      const result = await agent.prompt("Test");

      const latency = result.getLatency();
      expect(latency).toHaveProperty("e2eMs");
      expect(latency).toHaveProperty("llmMs");
      expect(latency).toHaveProperty("mcpMs");
      expect(latency.e2eMs).toBeGreaterThanOrEqual(0);
      expect(latency.llmMs).toBeGreaterThanOrEqual(0);
      expect(latency.mcpMs).toBeGreaterThanOrEqual(0);
    });

    it("should handle non-Error exceptions", async () => {
      mockGenerateText.mockRejectedValueOnce("String error");

      const agent = new TestAgent({
        tools: {},
        model: "openai/gpt-4o",
        apiKey: "test-api-key",
      });

      const result = await agent.prompt("Test prompt");

      expect(result.hasError()).toBe(true);
      expect(result.getError()).toBe("String error");
    });

    it("should call createModelFromString with correct options", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "OK",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const agent = new TestAgent({
        tools: {},
        model: "anthropic/claude-3-5-sonnet-20241022",
        apiKey: "my-api-key",
      });

      await agent.prompt("Test");

      expect(mockCreateModel).toHaveBeenCalledWith(
        "anthropic/claude-3-5-sonnet-20241022",
        expect.objectContaining({
          apiKey: "my-api-key",
        })
      );
    });

    it("should pass system prompt and temperature to generateText", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "OK",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-key",
        systemPrompt: "You are a math tutor.",
        temperature: 0.3,
        maxSteps: 15,
      });

      await agent.prompt("What is 2+2?");

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          system: "You are a math tutor.",
          prompt: "What is 2+2?",
          temperature: 0.3,
          stopWhen: { type: "stepCount", value: 15 },
        })
      );

      // Verify tools are passed (instrumented for latency tracking)
      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      expect(callArgs.tools).toBeDefined();
      expect(Object.keys(callArgs.tools)).toEqual(Object.keys(mockToolSet));

      // Verify onStepFinish callback is provided for latency tracking
      expect(callArgs.onStepFinish).toBeInstanceOf(Function);
    });

    it("should handle empty usage data", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "Response",
        steps: [],
        // No usage data
      } as any);

      const agent = new TestAgent({
        tools: {},
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      const result = await agent.prompt("Test");

      expect(result.inputTokens()).toBe(0);
      expect(result.outputTokens()).toBe(0);
      expect(result.totalTokens()).toBe(0);
    });
  });

  describe("toolsCalled()", () => {
    it("should return empty array if no prompt has been run", () => {
      const agent = new TestAgent({
        tools: {},
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      expect(agent.toolsCalled()).toEqual([]);
    });

    it("should return tools from last prompt", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "Done",
        steps: [{ toolCalls: [{ toolName: "add", args: {} }] }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      await agent.prompt("Add numbers");

      expect(agent.toolsCalled()).toEqual(["add"]);
    });

    it("should update with each prompt", async () => {
      mockGenerateText
        .mockResolvedValueOnce({
          text: "Added",
          steps: [{ toolCalls: [{ toolName: "add", args: {} }] }],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as any)
        .mockResolvedValueOnce({
          text: "Subtracted",
          steps: [{ toolCalls: [{ toolName: "subtract", args: {} }] }],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as any);

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      await agent.prompt("Add");
      expect(agent.toolsCalled()).toEqual(["add"]);

      await agent.prompt("Subtract");
      expect(agent.toolsCalled()).toEqual(["subtract"]);
    });
  });

  describe("withOptions()", () => {
    it("should create a new agent with merged options", () => {
      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "original-key",
        systemPrompt: "Original prompt",
        temperature: 0.7,
        maxSteps: 10,
      });

      const newAgent = agent.withOptions({
        model: "anthropic/claude-3-5-sonnet-20241022",
        temperature: 0.3,
      });

      // New agent has updated values
      expect(newAgent.getModel()).toBe("anthropic/claude-3-5-sonnet-20241022");
      expect(newAgent.getTemperature()).toBe(0.3);

      // New agent inherits unchanged values
      expect(newAgent.getTools()).toBe(mockToolSet);
      expect(newAgent.getApiKey()).toBe("original-key");
      expect(newAgent.getSystemPrompt()).toBe("Original prompt");
      expect(newAgent.getMaxSteps()).toBe(10);

      // Original agent is unchanged
      expect(agent.getModel()).toBe("openai/gpt-4o");
      expect(agent.getTemperature()).toBe(0.7);
    });

    it("should create independent instances", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "Original",
        steps: [{ toolCalls: [{ toolName: "add", args: {} }] }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "key",
      });

      const newAgent = agent.withOptions({ temperature: 0.5 });

      await agent.prompt("Test");

      // Original agent has the result
      expect(agent.toolsCalled()).toEqual(["add"]);
      // New agent does not
      expect(newAgent.toolsCalled()).toEqual([]);
    });
  });

  describe("getLastResult()", () => {
    it("should return undefined if no prompt has been run", () => {
      const agent = new TestAgent({
        tools: {},
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      expect(agent.getLastResult()).toBeUndefined();
    });

    it("should return the last prompt result", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "The answer",
        steps: [],
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      } as any);

      const agent = new TestAgent({
        tools: {},
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      const promptResult = await agent.prompt("Question");
      const lastResult = agent.getLastResult();

      expect(lastResult).toBe(promptResult);
      expect(lastResult?.text).toBe("The answer");
    });
  });

  describe("app-only tool filtering", () => {
    // Helper to create a mock Tool with visibility
    const createMockTool = (
      name: string,
      visibility?: Array<"model" | "app">
    ): Tool => ({
      name,
      description: `Mock ${name} tool`,
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      _meta: visibility
        ? { _serverId: "test", ui: { visibility } }
        : { _serverId: "test" },
    });

    it("should filter out app-only tools (visibility: ['app'])", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "OK",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const tools: Tool[] = [
        createMockTool("modelTool", ["model"]),
        createMockTool("appOnlyTool", ["app"]),
        createMockTool("noVisibilityTool"),
      ];

      const agent = new TestAgent({
        tools,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      await agent.prompt("Test");

      // Verify the tools passed to generateText
      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      const toolNames = Object.keys(callArgs.tools);

      expect(toolNames).toContain("modelTool");
      expect(toolNames).not.toContain("appOnlyTool");
      expect(toolNames).toContain("noVisibilityTool");
    });

    it("should include tools with visibility: ['model', 'app']", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "OK",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const tools: Tool[] = [
        createMockTool("bothVisibilityTool", ["model", "app"]),
        createMockTool("appOnlyTool", ["app"]),
      ];

      const agent = new TestAgent({
        tools,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      await agent.prompt("Test");

      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      const toolNames = Object.keys(callArgs.tools);

      expect(toolNames).toContain("bothVisibilityTool");
      expect(toolNames).not.toContain("appOnlyTool");
    });

    it("should include tools with visibility: ['model']", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "OK",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const tools: Tool[] = [createMockTool("modelOnlyTool", ["model"])];

      const agent = new TestAgent({
        tools,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      await agent.prompt("Test");

      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      const toolNames = Object.keys(callArgs.tools);

      expect(toolNames).toContain("modelOnlyTool");
    });

    it("should include tools with no _meta.ui.visibility", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "OK",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const tools: Tool[] = [createMockTool("noVisibilityTool")];

      const agent = new TestAgent({
        tools,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      await agent.prompt("Test");

      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      const toolNames = Object.keys(callArgs.tools);

      expect(toolNames).toContain("noVisibilityTool");
    });
  });
});
