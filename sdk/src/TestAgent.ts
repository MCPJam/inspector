/**
 * TestAgent - Runs LLM prompts with tool calling for evals
 */

import { generateText, stepCountIs } from "ai";
import type { ToolSet } from "ai";
import { createModelFromString } from "./model-factory.js";
import type { CreateModelOptions } from "./model-factory.js";
import { extractToolCalls } from "./tool-extraction.js";
import { PromptResult } from "./PromptResult.js";
import type { CustomProvider } from "./types.js";

/**
 * Configuration for creating a TestAgent
 */
export interface TestAgentConfig {
  /** Tools to provide to the LLM (AI SDK ToolSet format from manager.getToolsForAiSdk()) */
  tools: ToolSet;
  /** LLM provider and model string (e.g., "openai/gpt-4o", "anthropic/claude-3-5-sonnet-20241022") */
  llm: string;
  /** API key for the LLM provider */
  apiKey: string;
  /** System prompt for the LLM (default: "You are a helpful assistant.") */
  systemPrompt?: string;
  /** Temperature for LLM responses (0-2, default: 0.7) */
  temperature?: number;
  /** Maximum number of agentic steps/tool calls (default: 10) */
  maxSteps?: number;
  /** Custom providers registry for non-standard LLM providers */
  customProviders?:
    | Map<string, CustomProvider>
    | Record<string, CustomProvider>;
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
 *   llm: "openai/gpt-4o",
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
  private readonly llm: string;
  private readonly apiKey: string;
  private systemPrompt: string;
  private temperature: number;
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
    this.tools = config.tools;
    this.llm = config.llm;
    this.apiKey = config.apiKey;
    this.systemPrompt = config.systemPrompt ?? "You are a helpful assistant.";
    this.temperature = config.temperature ?? 0.7;
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
   * Run a prompt with the LLM, allowing tool calls.
   * Never throws - errors are returned in the PromptResult.
   *
   * @param message - The user message to send to the LLM
   * @returns PromptResult with text response, tool calls, token usage, and latency breakdown
   */
  async prompt(message: string): Promise<PromptResult> {
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
      const model = createModelFromString(this.llm, modelOptions);

      // Instrument tools to track MCP execution time
      const instrumentedTools = this.createInstrumentedTools((ms) => {
        totalMcpMs += ms;
        stepMcpMs += ms; // Accumulate per-step for LLM calculation
      });

      // Cast model to any to handle AI SDK version compatibility
      const result = await generateText({
        model: model as any,
        tools: instrumentedTools,
        system: this.systemPrompt,
        prompt: message,
        temperature: this.temperature,
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

      // Extract tool calls from result steps
      const toolCalls = extractToolCalls(result);

      // Use totalUsage for multi-step agents (aggregates tokens across all steps)
      // Fall back to usage (final step only) for single-step prompts
      const usage = result.totalUsage ?? result.usage;
      const inputTokens = usage?.inputTokens ?? 0;
      const outputTokens = usage?.outputTokens ?? 0;

      this.lastResult = PromptResult.from({
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

      this.lastResult = PromptResult.error(errorMessage, {
        e2eMs,
        llmMs: totalLlmMs,
        mcpMs: totalMcpMs,
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
      llm: options.llm ?? this.llm,
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
  getLlm(): string {
    return this.llm;
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
   * Get the current temperature
   */
  getTemperature(): number {
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
