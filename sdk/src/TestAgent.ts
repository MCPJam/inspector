/**
 * TestAgent - Runs LLM prompts with tool calling for evals
 */

import {
  generateText,
  hasToolCall,
  stepCountIs,
  dynamicTool,
  jsonSchema,
} from "ai";
import type {
  StopCondition,
  ToolSet,
  ModelMessage,
  UserModelMessage,
} from "ai";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createModelFromString, parseLLMString } from "./model-factory.js";
import type { CreateModelOptions } from "./model-factory.js";
import { extractToolCalls } from "./tool-extraction.js";
import { PromptResult } from "./PromptResult.js";
import type { CustomProvider, ToolCall as PromptToolCall } from "./types.js";
import type { EvalAgent, PromptOptions } from "./EvalAgent.js";
import type { Tool, AiSdkTool } from "./mcp-client-manager/types.js";
import type { MCPClientManager } from "./mcp-client-manager/MCPClientManager.js";
import type { EvalWidgetSnapshotInput } from "./eval-reporting-types.js";
import { ensureJsonSchemaObject } from "./mcp-client-manager/tool-converters.js";
import { buildMcpAppWidgetSnapshot } from "./widget-snapshots.js";
import { injectOpenAICompat } from "./widget-helpers.js";

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
  /** Optional MCP client manager for capturing MCP App replay snapshots */
  mcpClientManager?: MCPClientManager;
}

// Re-export PromptOptions for backward compatibility
export type { PromptOptions } from "./EvalAgent.js";

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

type StartedToolCall = {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  shortCircuited: boolean;
};

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
export class TestAgent implements EvalAgent {
  private readonly tools: ToolSet;
  private readonly model: string;
  private readonly apiKey: string;
  private systemPrompt: string;
  private temperature: number | undefined;
  private readonly maxSteps: number;
  private readonly customProviders?:
    | Map<string, CustomProvider>
    | Record<string, CustomProvider>;
  private readonly mcpClientManager?: MCPClientManager;

  /** Normalized provider name parsed from the model string */
  private readonly _parsedProvider: string;
  /** Normalized model name parsed from the model string */
  private readonly _parsedModel: string;

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
    this.mcpClientManager = config.mcpClientManager;

    // Parse the model string once to extract provider/model metadata
    try {
      const parsed = parseLLMString(config.model);
      this._parsedProvider =
        parsed.type === "builtin" ? parsed.provider : parsed.providerName;
      this._parsedModel = parsed.model;
    } catch {
      // Fallback for unparseable model strings (e.g., mock agents)
      const parts = config.model.split("/");
      this._parsedProvider = parts.length > 1 ? parts[0] : "";
      this._parsedModel =
        parts.length > 1 ? parts.slice(1).join("/") : config.model;
    }
  }

  /**
   * Create instrumented tools that track execution latency.
   * @param onLatency - Callback to report latency for each tool execution
   * @returns ToolSet with instrumented execute functions
   */
  private warnWidgetSnapshotFailure(
    toolName: string,
    message: string,
    error?: unknown
  ) {
    const suffix =
      error instanceof Error
        ? `: ${error.message}`
        : error
          ? `: ${String(error)}`
          : "";
    console.warn(
      `[mcpjam/sdk] skipped widget snapshot for "${toolName}"${suffix || `: ${message}`}`
    );
  }

  private async captureMcpAppSnapshot(params: {
    toolName: string;
    tool: ToolSet[string];
    options: { toolCallId?: string } | undefined;
    toolInput: Record<string, unknown>;
    toolOutput: unknown;
    snapshotBuffer: Map<string, EvalWidgetSnapshotInput>;
  }) {
    if (!this.mcpClientManager) {
      return;
    }

    const toolCallId =
      typeof params.options?.toolCallId === "string"
        ? params.options.toolCallId
        : undefined;
    if (!toolCallId) {
      return;
    }

    const serverId = (params.tool as any)._serverId;
    if (typeof serverId !== "string" || !serverId) {
      return;
    }

    const toolMetadata = this.mcpClientManager.getToolMetadata(
      serverId,
      params.toolName
    );
    if (!toolMetadata) {
      return;
    }

    const ui = toolMetadata.ui as { resourceUri?: string } | undefined;
    const resourceUri =
      typeof ui?.resourceUri === "string" ? ui.resourceUri : undefined;
    if (!resourceUri) {
      return;
    }

    try {
      const resourceResult = await this.mcpClientManager.readResource(
        serverId,
        {
          uri: resourceUri,
        }
      );
      const contents = Array.isArray((resourceResult as any)?.contents)
        ? (resourceResult as any).contents
        : [];
      const content = contents[0];
      if (!content) {
        this.warnWidgetSnapshotFailure(
          params.toolName,
          "resource read returned no content"
        );
        return;
      }

      const snapshot = buildMcpAppWidgetSnapshot({
        toolCallId,
        toolName: params.toolName,
        serverId,
        resourceUri,
        toolMetadata,
        resourceContent: content,
      });
      if (!snapshot) {
        this.warnWidgetSnapshotFailure(
          params.toolName,
          "resource did not contain HTML content"
        );
        return;
      }

      // Inject the OpenAI compat runtime so stored blobs are self-contained
      // (identical to what the server injects for live widgets and Views)
      snapshot.widgetHtml = injectOpenAICompat(snapshot.widgetHtml ?? "", {
        toolId: toolCallId,
        toolName: params.toolName,
        toolInput: params.toolInput ?? {},
        toolOutput: params.toolOutput,
        theme: "dark",
        viewMode: "inline",
        viewParams: {},
      });

      params.snapshotBuffer.set(toolCallId, snapshot);
    } catch (error) {
      this.warnWidgetSnapshotFailure(
        params.toolName,
        "resource read failed",
        error
      );
    }
  }

  private createInstrumentedTools(
    onLatency: (ms: number) => void,
    snapshotBuffer: Map<string, EvalWidgetSnapshotInput>,
    pendingStepToolCalls: StartedToolCall[],
    shortCircuitTools?: Set<string>
  ): ToolSet {
    const instrumented: ToolSet = {};
    for (const [name, tool] of Object.entries(this.tools)) {
      // Only instrument tools that have an execute function
      if (tool.execute) {
        const originalExecute = tool.execute;
        instrumented[name] = {
          ...tool,
          execute: async (args: any, options: any) => {
            const start = Date.now();
            const toolCallId =
              typeof options?.toolCallId === "string"
                ? options.toolCallId
                : `${name}-${pendingStepToolCalls.length + 1}`;
            const toolInput = (args ?? {}) as Record<string, unknown>;
            const shouldShortCircuit = shortCircuitTools?.has(name) ?? false;

            pendingStepToolCalls.push({
              toolCallId,
              toolName: name,
              arguments: toolInput,
              shortCircuited: shouldShortCircuit,
            });

            try {
              if (shouldShortCircuit) {
                return CallToolResultSchema.parse({
                  content: [
                    {
                      type: "text",
                      text: "[skipped by stopAfterToolCall]",
                    },
                  ],
                });
              }

              const result = await originalExecute(args, options);
              await this.captureMcpAppSnapshot({
                toolName: name,
                tool,
                options,
                toolInput,
                toolOutput: result,
                snapshotBuffer,
              });
              return result;
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

  private resolveStopWhen(
    stopWhen?: PromptOptions["stopWhen"],
    stopAfterToolCall?: PromptOptions["stopAfterToolCall"]
  ): Array<StopCondition<ToolSet>> {
    const base = [stepCountIs(this.maxSteps)];
    const conditions =
      stopWhen == null ? [] : Array.isArray(stopWhen) ? stopWhen : [stopWhen];
    const stopAfterConditions = this.normalizeStopAfterToolCall(
      stopAfterToolCall
    ).map((toolName) => hasToolCall(toolName));

    return [...base, ...conditions, ...stopAfterConditions];
  }

  private normalizeStopAfterToolCall(
    stopAfterToolCall?: PromptOptions["stopAfterToolCall"]
  ): string[] {
    if (stopAfterToolCall == null) {
      return [];
    }

    return Array.isArray(stopAfterToolCall)
      ? stopAfterToolCall
      : [stopAfterToolCall];
  }

  private buildPartialAssistantMessages(
    pendingStepToolCalls: StartedToolCall[]
  ): ModelMessage[] {
    if (pendingStepToolCalls.length === 0) {
      return [];
    }

    return [
      {
        role: "assistant",
        content: pendingStepToolCalls.map((toolCall) => ({
          type: "tool-call" as const,
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.arguments,
        })),
      },
    ];
  }

  /**
   * Build an array of ModelMessages from previous PromptResult(s) for multi-turn context.
   * @param context - Single PromptResult or array of PromptResults to include as context
   * @returns Array of ModelMessages representing the conversation history
   */
  private buildContextMessages(
    context: PromptResult | PromptResult[] | undefined
  ): ModelMessage[] {
    if (!context) {
      return [];
    }

    const results = Array.isArray(context) ? context : [context];
    const messages: ModelMessage[] = [];

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
    const widgetSnapshots = new Map<string, EvalWidgetSnapshotInput>();
    const completedToolCalls: PromptToolCall[] = [];
    const pendingStepToolCalls: StartedToolCall[] = [];
    let lastCompletedStepMessages: ModelMessage[] = [];
    let partialInputTokens = 0;
    let partialOutputTokens = 0;
    let lastCompletedStepText = "";

    try {
      const modelOptions: CreateModelOptions = {
        apiKey: this.apiKey,
        customProviders: this.customProviders,
      };
      const model = createModelFromString(this.model, modelOptions);
      const stopAfterToolCallNames = this.normalizeStopAfterToolCall(
        options?.stopAfterToolCall
      );

      // Instrument tools to track MCP execution time
      const instrumentedTools = this.createInstrumentedTools(
        (ms) => {
          totalMcpMs += ms;
          stepMcpMs += ms; // Accumulate per-step for LLM calculation
        },
        widgetSnapshots,
        pendingStepToolCalls,
        new Set(stopAfterToolCallNames)
      );

      // Build messages array if context is provided for multi-turn
      const contextMessages = this.buildContextMessages(options?.context);
      const userMessage: UserModelMessage = { role: "user", content: message };
      const resolvedTimeout = options?.timeout ?? options?.timeoutMs;

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
        ...(options?.abortSignal !== undefined && {
          abortSignal: options.abortSignal,
        }),
        ...(resolvedTimeout !== undefined && {
          timeout: resolvedTimeout,
        }),
        stopWhen: this.resolveStopWhen(
          options?.stopWhen,
          options?.stopAfterToolCall
        ),
        onStepFinish: (stepResult) => {
          const now = Date.now();
          const stepDuration = now - lastStepEndTime;
          // LLM time for this step = step duration - MCP time in this step
          totalLlmMs += Math.max(0, stepDuration - stepMcpMs);
          lastStepEndTime = now;
          stepMcpMs = 0; // Reset for next step

          if (!stepResult) {
            return;
          }

          partialInputTokens += stepResult.usage?.inputTokens ?? 0;
          partialOutputTokens += stepResult.usage?.outputTokens ?? 0;
          lastCompletedStepText = stepResult.text ?? "";
          lastCompletedStepMessages = stepResult.response?.messages
            ? [...stepResult.response.messages]
            : [];
          completedToolCalls.push(
            ...stepResult.toolCalls.map((toolCall) => ({
              toolName: toolCall.toolName,
              arguments: (toolCall.input ?? {}) as Record<string, unknown>,
            }))
          );
          pendingStepToolCalls.length = 0;
        },
      });

      const e2eMs = Date.now() - startTime;
      const toolCalls = extractToolCalls(result);
      const usage = result.totalUsage ?? result.usage;
      const inputTokens = usage?.inputTokens ?? 0;
      const outputTokens = usage?.outputTokens ?? 0;

      const messages: ModelMessage[] = [];
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
        provider: this._parsedProvider,
        model: this._parsedModel,
        widgetSnapshots: Array.from(widgetSnapshots.values()),
      });

      this.promptHistory.push(this.lastResult);
      return this.lastResult;
    } catch (error) {
      const e2eMs = Date.now() - startTime;
      const abortReason = options?.abortSignal?.aborted
        ? options.abortSignal.reason
        : undefined;
      const errorMessage =
        abortReason instanceof Error
          ? abortReason.message
          : abortReason != null
            ? String(abortReason)
            : error instanceof Error
              ? error.message
              : String(error);
      const partialMessages: ModelMessage[] = [
        { role: "user", content: message },
        ...lastCompletedStepMessages,
        ...this.buildPartialAssistantMessages(pendingStepToolCalls),
      ];
      const partialToolCalls = [
        ...completedToolCalls,
        ...pendingStepToolCalls.map((toolCall) => ({
          toolName: toolCall.toolName,
          arguments: toolCall.arguments,
        })),
      ];
      const totalTokens = partialInputTokens + partialOutputTokens;

      this.lastResult = PromptResult.from({
        prompt: message,
        messages: partialMessages,
        text: lastCompletedStepText,
        toolCalls: partialToolCalls,
        usage: {
          inputTokens: partialInputTokens,
          outputTokens: partialOutputTokens,
          totalTokens,
        },
        latency: {
          e2eMs,
          llmMs: totalLlmMs,
          mcpMs: totalMcpMs,
        },
        error: errorMessage,
        provider: this._parsedProvider,
        model: this._parsedModel,
        widgetSnapshots: Array.from(widgetSnapshots.values()),
      });
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
      mcpClientManager: options.mcpClientManager ?? this.mcpClientManager,
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
    this.lastResult = undefined;
  }

  /**
   * Get the history of all prompt results since the last reset.
   * Returns a copy of the array to prevent external modification.
   */
  getPromptHistory(): PromptResult[] {
    return [...this.promptHistory];
  }

  /**
   * Get the normalized provider name parsed from the model string.
   */
  getParsedProvider(): string {
    return this._parsedProvider;
  }

  /**
   * Get the normalized model name parsed from the model string.
   */
  getParsedModel(): string {
    return this._parsedModel;
  }

  /**
   * Create a mock TestAgent for deterministic eval tests.
   * The mock agent calls the provided function instead of making real LLM calls.
   *
   * @param promptFn - Function that returns a PromptResult for a given message
   * @returns A TestAgent-compatible object for use in EvalTest/EvalSuite
   *
   * @example
   * ```typescript
   * const agent = TestAgent.mock(async (message) =>
   *   PromptResult.from({
   *     prompt: message,
   *     messages: [{ role: "user", content: message }],
   *     text: "mocked response",
   *     toolCalls: [{ toolName: "my_tool", arguments: {} }],
   *     usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
   *     latency: { e2eMs: 100, llmMs: 80, mcpMs: 20 },
   *   })
   * );
   *
   * const test = new EvalTest({
   *   name: "my-test",
   *   test: async (a) => {
   *     const r = await a.prompt("test");
   *     return r.hasToolCall("my_tool");
   *   },
   * });
   * await test.run(agent, { iterations: 3 });
   * ```
   */
  static mock(
    promptFn: (
      message: string,
      options?: PromptOptions
    ) => PromptResult | Promise<PromptResult>
  ): EvalAgent {
    const createAgent = (): EvalAgent => {
      let promptHistory: PromptResult[] = [];

      return {
        prompt: async (message: string, options?: PromptOptions) => {
          const result = await promptFn(message, options);
          promptHistory.push(result);
          return result;
        },
        resetPromptHistory: () => {
          promptHistory = [];
        },
        getPromptHistory: () => [...promptHistory],
        withOptions: () => createAgent(),
      };
    };

    return createAgent();
  }
}
