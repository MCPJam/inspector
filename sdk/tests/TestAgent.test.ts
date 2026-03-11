import { TestAgent } from "../src/TestAgent";
import { PromptResult } from "../src/PromptResult";
import type { ToolSet } from "ai";
import type { Tool } from "../src/mcp-client-manager/types";

// Mock the ai module
jest.mock("ai", () => ({
  generateText: jest.fn(),
  hasToolCall: jest.fn((name: string) => ({
    type: "hasToolCall",
    value: name,
  })),
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

import { generateText, hasToolCall, jsonSchema, stepCountIs } from "ai";
import { createModelFromString } from "../src/model-factory";

const mockGenerateText = generateText as jest.MockedFunction<
  typeof generateText
>;
const mockHasToolCall = hasToolCall as jest.MockedFunction<typeof hasToolCall>;
const mockStepCountIs = stepCountIs as jest.MockedFunction<typeof stepCountIs>;
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

  function createMcpAppToolSet(): ToolSet {
    const createViewTool = {
      description: "Create a saved view",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          title: { type: "string" },
        },
        required: ["title"],
      }),
      execute: jest.fn(async (args: { title: string }) => ({
        content: [{ type: "text", text: `Created ${args.title}` }],
      })),
    } as ToolSet[string] & { _serverId?: string };

    createViewTool._serverId = "server-1";

    return {
      create_view: createViewTool,
    };
  }

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

    it("captures widget snapshots across multiple MCP App tool calls", async () => {
      const tools = createMcpAppToolSet();
      const mockManager = {
        getToolMetadata: jest.fn().mockReturnValue({
          ui: { resourceUri: "ui://widget/create-view.html" },
        }),
        readResource: jest
          .fn()
          .mockResolvedValueOnce({
            contents: [
              {
                text: "<html>First widget</html>",
                _meta: {
                  ui: {
                    csp: { connectDomains: ["https://api.example.com"] },
                    permissions: { clipboardWrite: {} },
                    prefersBorder: false,
                  },
                },
              },
            ],
          })
          .mockResolvedValueOnce({
            contents: [
              {
                text: "<html>Second widget</html>",
                _meta: {
                  ui: {
                    csp: { resourceDomains: ["https://cdn.example.com"] },
                    permissions: { camera: {} },
                    prefersBorder: true,
                  },
                },
              },
            ],
          }),
      };

      mockGenerateText.mockImplementationOnce(async (params: any) => {
        await params.tools.create_view.execute(
          { title: "Flow 1" },
          { toolCallId: "call-1", abortSignal: { throwIfAborted: jest.fn() } }
        );
        params.onStepFinish?.();

        await params.tools.create_view.execute(
          { title: "Flow 2" },
          { toolCallId: "call-2", abortSignal: { throwIfAborted: jest.fn() } }
        );
        params.onStepFinish?.();

        return {
          text: "Saved both views",
          steps: [
            {
              toolCalls: [
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "create_view",
                  input: { title: "Flow 1" },
                },
              ],
            },
            {
              toolCalls: [
                {
                  type: "tool-call",
                  toolCallId: "call-2",
                  toolName: "create_view",
                  input: { title: "Flow 2" },
                },
              ],
            },
          ],
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        } as any;
      });

      const agent = new TestAgent({
        tools,
        model: "openai/gpt-4o",
        apiKey: "test-api-key",
        mcpClientManager: mockManager as any,
      });

      const result = await agent.prompt("Create two views");

      expect(result.getWidgetSnapshots()).toHaveLength(2);

      const snap0 = result.getWidgetSnapshots()[0];
      expect(snap0).toEqual(
        expect.objectContaining({
          toolCallId: "call-1",
          toolName: "create_view",
          protocol: "mcp-apps",
          serverId: "server-1",
          resourceUri: "ui://widget/create-view.html",
          widgetPermissive: true,
          prefersBorder: false,
        })
      );
      // widgetHtml should contain the injected OpenAI compat runtime
      expect(snap0.widgetHtml).toContain('id="openai-compat-config"');
      expect(snap0.widgetHtml).toContain("First widget");

      const snap1 = result.getWidgetSnapshots()[1];
      expect(snap1).toEqual(
        expect.objectContaining({
          toolCallId: "call-2",
          prefersBorder: true,
        })
      );
      expect(snap1.widgetHtml).toContain('id="openai-compat-config"');
      expect(snap1.widgetHtml).toContain("Second widget");
      expect(mockManager.getToolMetadata).toHaveBeenCalledTimes(2);
      expect(mockManager.readResource).toHaveBeenCalledTimes(2);
    });

    it("warns and skips widget snapshots when resource reads fail", async () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
      const tools = createMcpAppToolSet();
      const mockManager = {
        getToolMetadata: jest.fn().mockReturnValue({
          ui: { resourceUri: "ui://widget/create-view.html" },
        }),
        readResource: jest.fn().mockRejectedValue(new Error("server hiccup")),
      };

      mockGenerateText.mockImplementationOnce(async (params: any) => {
        await params.tools.create_view.execute(
          { title: "Flow 1" },
          { toolCallId: "call-1", abortSignal: { throwIfAborted: jest.fn() } }
        );
        params.onStepFinish?.();

        return {
          text: "Done",
          steps: [
            {
              toolCalls: [
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "create_view",
                  input: { title: "Flow 1" },
                },
              ],
            },
          ],
          usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
        } as any;
      });

      const agent = new TestAgent({
        tools,
        model: "openai/gpt-4o",
        apiKey: "test-api-key",
        mcpClientManager: mockManager as any,
      });

      const result = await agent.prompt("Create a view");

      expect(result.hasError()).toBe(false);
      expect(result.getWidgetSnapshots()).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipped widget snapshot for "create_view"')
      );
      warnSpy.mockRestore();
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

    it("should preserve partial tool calls and messages when aborted mid-tool", async () => {
      let notifyExecuteStarted: (() => void) | undefined;
      const executeStarted = new Promise<void>((resolve) => {
        notifyExecuteStarted = resolve;
      });
      const abortableToolSet: ToolSet = {
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
          execute: jest.fn(async (_args, options) => {
            notifyExecuteStarted?.();
            await new Promise((_, reject) => {
              options?.abortSignal?.addEventListener(
                "abort",
                () => reject(new Error("tool execution aborted")),
                { once: true }
              );
            });
          }),
        },
      };

      mockGenerateText.mockImplementationOnce(async (params: any) => {
        await params.tools.add.execute(
          { a: 2, b: 3 },
          {
            toolCallId: "call-1",
            abortSignal: params.abortSignal,
          }
        );

        return {
          text: "unreachable",
          steps: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        } as any;
      });

      const agent = new TestAgent({
        tools: abortableToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-api-key",
      });
      const abortController = new AbortController();
      const promptPromise = agent.prompt("Add 2 and 3", {
        abortSignal: abortController.signal,
      });

      await executeStarted;
      abortController.abort(new Error("Prompt aborted"));

      const result = await promptPromise;

      expect(result.hasError()).toBe(true);
      expect(result.getError()).toBe("Prompt aborted");
      expect(result.hasToolCall("add")).toBe(true);
      expect(result.getToolArguments("add")).toEqual({ a: 2, b: 3 });
      expect(result.getMessages()).toEqual([
        { role: "user", content: "Add 2 and 3" },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "add",
              input: { a: 2, b: 3 },
            },
          ],
        },
      ]);
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
      const guard = { kind: "max-step-guard" } as any;
      mockStepCountIs.mockReturnValueOnce(guard);

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

      expect(mockStepCountIs).toHaveBeenCalledWith(15);
      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          system: "You are a math tutor.",
          prompt: "What is 2+2?",
          temperature: 0.3,
          stopWhen: [guard],
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

    it("should clear toolsCalled, getLastResult, and getPromptHistory after resetPromptHistory", async () => {
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
      expect(agent.getLastResult()).toBeDefined();
      expect(agent.getPromptHistory()).toHaveLength(1);

      agent.resetPromptHistory();

      expect(agent.toolsCalled()).toEqual([]);
      expect(agent.getLastResult()).toBeUndefined();
      expect(agent.getPromptHistory()).toHaveLength(0);
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

  describe("provider/model metadata", () => {
    it("should parse builtin provider/model from model string", () => {
      const agent = new TestAgent({
        tools: {},
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      expect(agent.getParsedProvider()).toBe("openai");
      expect(agent.getParsedModel()).toBe("gpt-4o");
    });

    it("should parse multi-segment model names", () => {
      const agent = new TestAgent({
        tools: {},
        model: "openrouter/openai/gpt-5-mini",
        apiKey: "test-key",
      });

      expect(agent.getParsedProvider()).toBe("openrouter");
      expect(agent.getParsedModel()).toBe("openai/gpt-5-mini");
    });

    it("should handle unparseable model strings gracefully", () => {
      const agent = new TestAgent({
        tools: {},
        model: "just-a-model",
        apiKey: "test-key",
      });

      expect(agent.getParsedProvider()).toBe("");
      expect(agent.getParsedModel()).toBe("just-a-model");
    });

    it("should inject provider/model into PromptResult on success", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "OK",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const agent = new TestAgent({
        tools: {},
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      const result = await agent.prompt("Test");
      expect(result.getProvider()).toBe("openai");
      expect(result.getModel()).toBe("gpt-4o");
    });

    it("should inject provider/model into PromptResult on error", async () => {
      mockGenerateText.mockRejectedValueOnce(new Error("fail"));

      const agent = new TestAgent({
        tools: {},
        model: "anthropic/claude-3-5-sonnet-20241022",
        apiKey: "test-key",
      });

      const result = await agent.prompt("Test");
      expect(result.getProvider()).toBe("anthropic");
      expect(result.getModel()).toBe("claude-3-5-sonnet-20241022");
    });
  });

  describe("mock()", () => {
    it("should create a mock agent that calls promptFn", async () => {
      const agent = TestAgent.mock(async (message) =>
        PromptResult.from({
          prompt: message,
          messages: [{ role: "user", content: message }],
          text: "mocked",
          toolCalls: [{ toolName: "test_tool", arguments: {} }],
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          latency: { e2eMs: 50, llmMs: 30, mcpMs: 20 },
        })
      );

      const result = await agent.prompt("hello");
      expect(result.text).toBe("mocked");
      expect(result.toolsCalled()).toEqual(["test_tool"]);
      expect(result.prompt).toBe("hello");
    });

    it("should track prompt history", async () => {
      const agent = TestAgent.mock(async (message) =>
        PromptResult.from({
          prompt: message,
          messages: [],
          text: message,
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          latency: { e2eMs: 0, llmMs: 0, mcpMs: 0 },
        })
      );

      await agent.prompt("first");
      await agent.prompt("second");
      expect(agent.getPromptHistory()).toHaveLength(2);
    });

    it("should reset prompt history", async () => {
      const agent = TestAgent.mock(async (message) =>
        PromptResult.from({
          prompt: message,
          messages: [],
          text: "",
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          latency: { e2eMs: 0, llmMs: 0, mcpMs: 0 },
        })
      );

      await agent.prompt("test");
      agent.resetPromptHistory();
      expect(agent.getPromptHistory()).toHaveLength(0);
    });

    it("should create independent clones via withOptions", async () => {
      const agent = TestAgent.mock(async (message) =>
        PromptResult.from({
          prompt: message,
          messages: [],
          text: "",
          toolCalls: [],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          latency: { e2eMs: 0, llmMs: 0, mcpMs: 0 },
        })
      );

      const clone = agent.withOptions({});
      await agent.prompt("original");
      expect(agent.getPromptHistory()).toHaveLength(1);
      expect(clone.getPromptHistory()).toHaveLength(0);
    });
  });

  describe("stopWhen", () => {
    it("should merge a single stop condition with maxSteps and still execute tools", async () => {
      const stopCondition = jest.fn(() => false);
      const guard = { kind: "max-step-guard" } as any;
      mockStepCountIs.mockReturnValueOnce(guard);

      mockGenerateText.mockImplementationOnce(async (params: any) => {
        const result = await params.tools.add.execute(
          { a: 2, b: 3 },
          { abortSignal: { throwIfAborted: jest.fn() } }
        );
        expect(result).toBe(5);
        params.onStepFinish?.();
        return {
          text: "Done",
          steps: [
            {
              toolCalls: [
                {
                  type: "tool-call",
                  toolCallId: "1",
                  toolName: "add",
                  input: { a: 2, b: 3 },
                },
              ],
            },
          ],
          usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
        } as any;
      });

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      const result = await agent.prompt("Add 2 and 3", {
        stopWhen: stopCondition as any,
      });

      expect(mockStepCountIs).toHaveBeenCalledWith(10);
      expect(result.hasToolCall("add")).toBe(true);
      expect(result.getToolArguments("add")).toEqual({ a: 2, b: 3 });

      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      expect(callArgs.stopWhen).toEqual([guard, stopCondition]);
    });

    it("should merge multiple stop conditions with maxSteps", async () => {
      const stopA = jest.fn(() => false);
      const stopB = jest.fn(() => true);
      const guard = { kind: "max-step-guard" } as any;
      mockStepCountIs.mockReturnValueOnce(guard);

      mockGenerateText.mockResolvedValueOnce({
        text: "Done",
        steps: [],
        usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      } as any);

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      await agent.prompt("Do math", {
        stopWhen: [stopA as any, stopB as any],
      });

      expect(mockStepCountIs).toHaveBeenCalledWith(10);
      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      expect(callArgs.stopWhen).toEqual([guard, stopA, stopB]);
    });

    it("should default to stepCountIs when stopWhen is not set", async () => {
      const guard = { kind: "max-step-guard" } as any;
      mockStepCountIs.mockReturnValueOnce(guard);

      mockGenerateText.mockResolvedValueOnce({
        text: "OK",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      await agent.prompt("Test");

      expect(mockStepCountIs).toHaveBeenCalledWith(10);
      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      expect(callArgs.stopWhen).toEqual([guard]);
    });
  });

  describe("stopAfterToolCall", () => {
    it("should append hasToolCall stop conditions for targeted tools", async () => {
      const guard = { kind: "max-step-guard" } as any;
      const stopOnAdd = { kind: "stop-on-add" } as any;
      mockStepCountIs.mockReturnValueOnce(guard);
      mockHasToolCall.mockReturnValueOnce(stopOnAdd);
      mockGenerateText.mockResolvedValueOnce({
        text: "Done",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      await agent.prompt("Add 2 and 3", {
        stopAfterToolCall: "add",
      });

      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      expect(callArgs.stopWhen).toEqual([guard, stopOnAdd]);
      expect(mockHasToolCall).toHaveBeenCalledWith("add");
    });

    it("should short-circuit the targeted tool and preserve tool arguments", async () => {
      const addExecute = jest.fn(
        async (args: { a: number; b: number }) => args.a + args.b
      );
      const subtractExecute = jest.fn(
        async (args: { a: number; b: number }) => args.a - args.b
      );
      const tools: ToolSet = {
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
          execute: addExecute,
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
          execute: subtractExecute,
        },
      };

      mockGenerateText.mockImplementationOnce(async (params: any) => {
        const addResult = await params.tools.add.execute(
          { a: 2, b: 3 },
          {
            toolCallId: "call-add",
            abortSignal: { throwIfAborted: jest.fn() },
          }
        );
        const subtractResult = await params.tools.subtract.execute(
          { a: 5, b: 2 },
          {
            toolCallId: "call-subtract",
            abortSignal: { throwIfAborted: jest.fn() },
          }
        );

        expect(addResult).toEqual({
          content: [{ type: "text", text: "[skipped by stopAfterToolCall]" }],
        });
        expect(subtractResult).toBe(3);

        return {
          text: "Done",
          steps: [
            {
              toolCalls: [
                {
                  type: "tool-call",
                  toolCallId: "call-add",
                  toolName: "add",
                  input: { a: 2, b: 3 },
                },
                {
                  type: "tool-call",
                  toolCallId: "call-subtract",
                  toolName: "subtract",
                  input: { a: 5, b: 2 },
                },
              ],
            },
          ],
          usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10 },
        } as any;
      });

      const agent = new TestAgent({
        tools,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });
      const result = await agent.prompt("Do some math", {
        stopAfterToolCall: "add",
      });

      expect(addExecute).not.toHaveBeenCalled();
      expect(subtractExecute).toHaveBeenCalledTimes(1);
      expect(result.hasToolCall("add")).toBe(true);
      expect(result.getToolArguments("add")).toEqual({ a: 2, b: 3 });
      expect(result.hasToolCall("subtract")).toBe(true);
    });

    it("should skip widget snapshot capture for short-circuited tools", async () => {
      const tools = createMcpAppToolSet();
      const createViewExecute = (tools.create_view as any).execute as jest.Mock;
      const mockManager = {
        getToolMetadata: jest.fn().mockReturnValue({
          ui: { resourceUri: "ui://widget/create-view.html" },
        }),
        readResource: jest.fn(),
      };

      mockGenerateText.mockImplementationOnce(async (params: any) => {
        await params.tools.create_view.execute(
          { title: "Flow 1" },
          { toolCallId: "call-1", abortSignal: { throwIfAborted: jest.fn() } }
        );

        return {
          text: "Done",
          steps: [
            {
              toolCalls: [
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "create_view",
                  input: { title: "Flow 1" },
                },
              ],
            },
          ],
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        } as any;
      });

      const agent = new TestAgent({
        tools,
        model: "openai/gpt-4o",
        apiKey: "test-key",
        mcpClientManager: mockManager as any,
      });
      const result = await agent.prompt("Create a view", {
        stopAfterToolCall: "create_view",
      });

      expect(result.getWidgetSnapshots()).toEqual([]);
      expect(createViewExecute).not.toHaveBeenCalled();
      expect(mockManager.getToolMetadata).not.toHaveBeenCalled();
      expect(mockManager.readResource).not.toHaveBeenCalled();
    });
  });

  describe("timeout", () => {
    it("should pass through a numeric timeout", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "OK",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      await agent.prompt("Test", { timeout: 5000 });

      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      expect(callArgs.timeout).toBe(5000);
    });

    it("should pass through an object timeout", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "OK",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      await agent.prompt("Test", {
        timeout: { totalMs: 5000, stepMs: 1000, chunkMs: 250 },
      });

      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      expect(callArgs.timeout).toEqual({
        totalMs: 5000,
        stepMs: 1000,
        chunkMs: 250,
      });
    });

    it("should pass through timeoutMs as a numeric timeout", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "OK",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      await agent.prompt("Test", { timeoutMs: 2500 });

      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      expect(callArgs.timeout).toBe(2500);
    });

    it("should prefer timeout over timeoutMs when both are provided", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "OK",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      await agent.prompt("Test", {
        timeout: { totalMs: 5000, stepMs: 1000 },
        timeoutMs: 2500,
      });

      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      expect(callArgs.timeout).toEqual({ totalMs: 5000, stepMs: 1000 });
    });

    it("should pass through abortSignal", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "OK",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });
      const abortController = new AbortController();

      await agent.prompt("Test", { abortSignal: abortController.signal });

      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      expect(callArgs.abortSignal).toBe(abortController.signal);
    });

    it("should omit timeout when it is not set", async () => {
      mockGenerateText.mockResolvedValueOnce({
        text: "OK",
        steps: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      } as any);

      const agent = new TestAgent({
        tools: mockToolSet,
        model: "openai/gpt-4o",
        apiKey: "test-key",
      });

      await agent.prompt("Test");

      const callArgs = mockGenerateText.mock.calls[0][0] as any;
      expect(callArgs).not.toHaveProperty("timeout");
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
