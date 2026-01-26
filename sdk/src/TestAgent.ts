/**
 * TestAgent - Runs LLM prompts with tool calling for evals
 */

import { generateText, stepCountIs, dynamicTool, jsonSchema } from "ai";
import type { ToolSet, CoreMessage, CoreUserMessage } from "ai";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createModelFromString } from "./model-factory.js";
import type { CreateModelOptions } from "./model-factory.js";
import { extractToolCalls } from "./tool-extraction.js";
import { PromptResult } from "./PromptResult.js";
import type { CustomProvider } from "./types.js";
import type { Tool, AiSdkTool } from "./mcp-client-manager/types.js";
import { ensureJsonSchemaObject } from "./mcp-client-manager/tool-converters.js";

/**
 * Configuration for creating a TestAgent
 */
export interface TestAgentConfig {
  /** Tools to provide to the LLM (Tool[] from manager.getTools() or AiSdkTool from manager.getToolsForAiSdk()) */
  tools: Tool[] | AiSdkTool;
  /** LLM provider and model string (e.g., "openai/gpt-4o", "anthropic/claude-3-5-sonnet-20241022") */
  model: string;
  /** API key for the LLM provider */
  apiKey: string;
  /** System prompt for the LLM (default: "You are a helpful assistant.") */
  systemPrompt?: string;
  /** Temperature for LLM responses (0-2). If undefined, uses model default. Some models (e.g., reasoning models) don't support temperature. */
  temperature?: number;
  /** Maximum number of agentic steps/tool calls (default: 10) */
  maxSteps?: number;
  /** Custom providers registry for non-standard LLM providers */
  customProviders?:
    | Map<string, CustomProvider>
    | Record<string, CustomProvider>;
}

/**
 * Options for the prompt() method
 */
export interface PromptOptions {
  /** Previous PromptResult(s) to include as conversation context for multi-turn conversations */
  context?: PromptResult | PromptResult[];
}

/**
 * Type guard to check if tools is Tool[] (from getTools())
 */
function isToolArray(tools: Tool[] | AiSdkTool): tools is Tool[] {
  return Array.isArray(tools);
}

/**
 * Converts Tool[] to AI SDK ToolSet format
 */
function convertToToolSet(tools: Tool[]): ToolSet {
  const toolSet: ToolSet = {};
  for (const tool of tools) {
    // Filter out app-only tools (visibility: ["app"]) per SEP-1865
    const visibility = (tool._meta?.ui as any)?.visibility as
      | Array<"model" | "app">
      | undefined;
    if (visibility && visibility.length === 1 && visibility[0] === "app") {
      continue;
    }

    const converted = dynamicTool({
      description: tool.description,
      inputSchema: jsonSchema(ensureJsonSchemaObject(tool.inputSchema)),
      execute: async (args, options) => {
        options?.abortSignal?.throwIfAborted?.();
        const result = await tool.execute(args as Record<string, unknown>);
        return CallToolResultSchema.parse(result);
      },
    });

    // Preserve _serverId like getToolsForAiSdk() does
    if (tool._meta?._serverId) {
      (converted as any)._serverId = tool._meta._serverId;
    }

    toolSet[tool.name] = converted;
  }
  return toolSet;
}

/**
 * Agent for running LLM prompts with tool calling.
 * Wraps the AI SDK generateText function with proper tool integration.
 *
 * @example
 * ```typescript
 * const manager = new MCPClientManager({
 *   everything: { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
 * });
 * await manager.connectToServer("everything");
 *
 * const agent = new TestAgent({
 *   tools: await manager.getToolsForAiSdk(["everything"]),
 *   model: "openai/gpt-4o",
 *   apiKey: process.env.OPENAI_API_KEY!,
 * });
 *
 * const result = await agent.prompt("Add 2 and 3");
 * console.log(result.toolsCalled()); // ["add"]
 * console.log(result.text); // "The result of adding 2 and 3 is 5."
 * ```
 */
export class TestAgent {
  private readonly tools: ToolSet;
  private readonly model: string;
  private readonly apiKey: string;
  private systemPrompt: string;
  private temperature: number | undefined;
  private readonly maxSteps: number;
  private readonly customProviders?:
    | Map<string, CustomProvider>
    | Record<string, CustomProvider>;

  /** The result of the last prompt (for toolsCalled() convenience method) */
  private lastResult: PromptResult | undefined;

  /** History of all prompt results during a test execution */
  private promptHistory: PromptResult[] = [];

  /**
   * Create a new TestAgent
   * @param config - Agent configuration
   */
  constructor(config: TestAgentConfig) {
    // Convert Tool[] to ToolSet if needed
    this.tools = isToolArray(config.tools)
      ? convertToToolSet(config.tools)
      : config.tools;
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.systemPrompt = config.systemPrompt ?? "You are a helpful assistant.";
    this.temperature = config.temperature;
    this.maxSteps = config.maxSteps ?? 10;
    this.customProviders = config.customProviders;
  }

  /**
   * Create instrumented tools that track execution latency.
   * @param onLatency - Callback to report latency for each tool execution
   * @returns ToolSet with instrumented execute functions
   */
  private createInstrumentedTools(onLatency: (ms: number) => void): ToolSet {
    const instrumented: ToolSet = {};
    for (const [name, tool] of Object.entries(this.tools)) {
      // Only instrument tools that have an execute function
      if (tool.execute) {
        const originalExecute = tool.execute;
        instrumented[name] = {
          ...tool,
          execute: async (args: any, options: any) => {
            const start = Date.now();
            try {
              return await originalExecute(args, options);
            } finally {
              onLatency(Date.now() - start);
            }
          },
        };
      } else {
        // Pass through tools without execute function unchanged
        instrumented[name] = tool;
      }
    }
    return instrumented;
  }

  /**
   * Build an array of CoreMessages from previous PromptResult(s) for multi-turn context.
   * @param context - Single PromptResult or array of PromptResults to include as context
   * @returns Array of CoreMessages representing the conversation history
   */
  private buildContextMessages(
    context: PromptResult | PromptResult[] | undefined
  ): CoreMessage[] {
    if (!context) {
      return [];
    }

    const results = Array.isArray(context) ? context : [context];
    const messages: CoreMessage[] = [];

    for (const result of results) {
      // Get all messages from this prompt result (user message + assistant/tool responses)
      messages.push(...result.getMessages());
    }

    return messages;
  }

  /**
   * Run a prompt with the LLM, allowing tool calls.
   * Never throws - errors are returned in the PromptResult.
   *
   * @param message - The user message to send to the LLM
   * @param options - Optional settings including context for multi-turn conversations
   * @returns PromptResult with text response, tool calls, token usage, and latency breakdown
   *
   * @example
   * // Single-turn (default)
   * const result = await agent.prompt("Show me workspaces");
   *
   * @example
   * // Multi-turn with context
   * const r1 = await agent.prompt("Show me workspaces");
   * const r2 = await agent.prompt("Now show tasks", { context: r1 });
   *
   * @example
   * // Multi-turn with multiple context results
   * const r1 = await agent.prompt("Show workspaces");
   * const r2 = await agent.prompt("Pick the first", { context: r1 });
   * const r3 = await agent.prompt("Show tasks", { context: [r1, r2] });
   */
  async prompt(
    message: string,
    options?: PromptOptions
  ): Promise<PromptResult> {
    const startTime = Date.now();
    let totalMcpMs = 0;
    let lastStepEndTime = startTime;
    let totalLlmMs = 0;
    let stepMcpMs = 0; // MCP time within current step

    try {
      const modelOptions: CreateModelOptions = {
        apiKey: this.apiKey,
        customProviders: this.customProviders,
      };
      const model = createModelFromString(this.model, modelOptions);

      // Instrument tools to track MCP execution time
      const instrumentedTools = this.createInstrumentedTools((ms) => {
        totalMcpMs += ms;
        stepMcpMs += ms; // Accumulate per-step for LLM calculation
      });

      // Build messages array if context is provided for multi-turn
      const contextMessages = this.buildContextMessages(options?.context);
      const userMessage: CoreUserMessage = { role: "user", content: message };

      // Cast model to any to handle AI SDK version compatibility
      const result = await generateText({
        model: model as any,
        tools: instrumentedTools,
        system: this.systemPrompt,
        // Use messages array for multi-turn, simple prompt for single-turn
        ...(contextMessages.length > 0
          ? { messages: [...contextMessages, userMessage] }
          : { prompt: message }),
        // Only include temperature if explicitly set (some models like reasoning models don't support it)
        ...(this.temperature !== undefined && {
          temperature: this.temperature,
        }),
        // Use stopWhen with stepCountIs for controlling max agentic steps
        // AI SDK v6+ uses this instead of maxSteps
        stopWhen: stepCountIs(this.maxSteps),
        onStepFinish: () => {
          const now = Date.now();
          const stepDuration = now - lastStepEndTime;
          // LLM time for this step = step duration - MCP time in this step
          totalLlmMs += Math.max(0, stepDuration - stepMcpMs);
          lastStepEndTime = now;
          stepMcpMs = 0; // Reset for next step
        },
      });

      const e2eMs = Date.now() - startTime;
      const toolCalls = extractToolCalls(result);
      const usage = result.totalUsage ?? result.usage;
      const inputTokens = usage?.inputTokens ?? 0;
      const outputTokens = usage?.outputTokens ?? 0;

      const messages: CoreMessage[] = [];
      messages.push(userMessage);

      // Add response messages (assistant + tool messages from agentic loop)
      if (result.response?.messages) {
        messages.push(...result.response.messages);
      }

      this.lastResult = PromptResult.from({
        prompt: message,
        messages,
        text: result.text,
        toolCalls,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        latency: { e2eMs, llmMs: totalLlmMs, mcpMs: totalMcpMs },
      });

      this.promptHistory.push(this.lastResult);
      return this.lastResult;
    } catch (error) {
      const e2eMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.lastResult = PromptResult.error(
        errorMessage,
        {
          e2eMs,
          llmMs: totalLlmMs,
          mcpMs: totalMcpMs,
        },
        message
      );
      this.promptHistory.push(this.lastResult);
      return this.lastResult;
    }
  }

  /**
   * Get the names of tools called in the last prompt.
   * Convenience method for quick checks in eval functions.
   *
   * @returns Array of tool names from the last prompt, or empty array if no prompt has been run
   */
  toolsCalled(): string[] {
    if (!this.lastResult) {
      return [];
    }
    return this.lastResult.toolsCalled();
  }

  /**
   * Create a new TestAgent with modified options.
   * Useful for creating variants for different test scenarios.
   *
   * @param options - Partial config to override
   * @returns A new TestAgent instance with the merged configuration
   */
  withOptions(options: Partial<TestAgentConfig>): TestAgent {
    return new TestAgent({
      tools: options.tools ?? this.tools,
      model: options.model ?? this.model,
      apiKey: options.apiKey ?? this.apiKey,
      systemPrompt: options.systemPrompt ?? this.systemPrompt,
      temperature: options.temperature ?? this.temperature,
      maxSteps: options.maxSteps ?? this.maxSteps,
      customProviders: options.customProviders ?? this.customProviders,
    });
  }

  /**
   * Get the configured tools
   */
  getTools(): ToolSet {
    return this.tools;
  }

  /**
   * Get the LLM provider/model string
   */
  getModel(): string {
    return this.model;
  }

  /**
   * Get the API key
   */
  getApiKey(): string {
    return this.apiKey;
  }

  /**
   * Get the current system prompt
   */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  /**
   * Set a new system prompt
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /**
   * Get the current temperature (undefined means model default)
   */
  getTemperature(): number | undefined {
    return this.temperature;
  }

  /**
   * Set the temperature (must be between 0 and 2)
   */
  setTemperature(temperature: number): void {
    if (temperature < 0 || temperature > 2) {
      throw new Error("Temperature must be between 0 and 2");
    }
    this.temperature = temperature;
  }

  /**
   * Get the max steps configuration
   */
  getMaxSteps(): number {
    return this.maxSteps;
  }

  /**
   * Get the result of the last prompt
   */
  getLastResult(): PromptResult | undefined {
    return this.lastResult;
  }

  /**
   * Reset the prompt history.
   * Call this before each test iteration to clear previous results.
   */
  resetPromptHistory(): void {
    this.promptHistory = [];
  }

  /**
   * Get the history of all prompt results since the last reset.
   * Returns a copy of the array to prevent external modification.
   */
  getPromptHistory(): PromptResult[] {
    return [...this.promptHistory];
  }
}
