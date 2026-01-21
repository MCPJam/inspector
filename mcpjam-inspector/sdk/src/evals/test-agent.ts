/**
 * TestAgent - Orchestration wrapper for running LLM queries with MCP tools.
 *
 * Combines MCPClientManager (or ToolSet), model creation, and tool call extraction
 * into a simple interface for evaluation testing.
 */

import { generateText, stepCountIs, type ToolSet, type CoreMessage } from "ai";
import { MCPClientManager } from "../mcp-client-manager/index.js";
import { createModelFromString, type BaseUrls } from "./model-factory.js";
import {
  extractToolCalls,
  type GenerateTextResult,
} from "./tool-extraction.js";
import { QueryResult } from "./query-result.js";
import type { TestAgentConfig, ToolCallWithMetadata } from "./types.js";

/**
 * Extended configuration for TestAgent including tools source.
 */
export interface TestAgentOptions extends TestAgentConfig {
  /**
   * Tools source - either an MCPClientManager instance or a pre-built ToolSet.
   * When using MCPClientManager, you can specify serverIds to filter which servers' tools to use.
   */
  tools: MCPClientManager | ToolSet;

  /**
   * Optional base URLs for LLM providers that support custom endpoints.
   */
  baseUrls?: BaseUrls;
}

/**
 * TestAgent provides a simple interface for running LLM queries with MCP tools
 * and extracting the results for evaluation purposes.
 *
 * @example
 * ```typescript
 * import { TestAgent } from "@mcpjam/sdk/evals";
 * import { MCPClientManager } from "@mcpjam/sdk";
 *
 * const manager = new MCPClientManager({
 *   asana: {
 *     url: new URL("https://mcp.asana.com/sse"),
 *     accessToken: process.env.ASANA_ACCESS_TOKEN,
 *   },
 * });
 *
 * await manager.connectToServer("asana");
 *
 * const agent = new TestAgent({
 *   tools: manager,
 *   serverIds: ["asana"],
 *   llm: "openai/gpt-4o",
 *   apiKey: process.env.OPENAI_API_KEY,
 *   systemPrompt: "You are a helpful assistant.",
 * });
 *
 * const result = await agent.query("Create a project called 'Onboard Joe'");
 *
 * console.log(result.toolsCalled());     // ["asana_create_project"]
 * console.log(result.totalTokens());     // 1234
 * ```
 */
export class TestAgent {
  private readonly options: TestAgentOptions;

  constructor(options: TestAgentOptions) {
    this.options = options;
  }

  /**
   * Runs a query against the LLM with the configured tools.
   *
   * @param prompt - The user query/prompt to send to the LLM
   * @param options - Optional per-query overrides
   * @returns QueryResult with tool calls, response, usage, and helper methods
   *
   * @example
   * ```typescript
   * const result = await agent.query("Create a task");
   *
   * if (result.hasToolCall("create_task")) {
   *   console.log("Task was created!");
   * }
   * ```
   */
  async query(
    prompt: string,
    options?: {
      /** Override system prompt for this query */
      systemPrompt?: string;
      /** Override temperature for this query */
      temperature?: number;
      /** Override max tokens for this query */
      maxTokens?: number;
      /** Maximum number of agentic steps */
      maxSteps?: number;
      /** Abort signal for cancellation */
      abortSignal?: AbortSignal;
    },
  ): Promise<QueryResult> {
    const startTime = performance.now();

    try {
      // Get tools
      const tools = await this.getTools();

      // Create model
      const model = createModelFromString(
        this.options.llm,
        this.options.apiKey,
        this.options.baseUrls,
      );

      // Build messages
      const messages: CoreMessage[] = [];

      const systemPrompt = options?.systemPrompt ?? this.options.systemPrompt;
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }

      messages.push({ role: "user", content: prompt });

      // Run generateText
      const maxSteps = options?.maxSteps ?? 20;
      const result = await generateText({
        model,
        messages,
        tools,
        stopWhen: stepCountIs(maxSteps),
        ...(options?.temperature !== undefined
          ? { temperature: options.temperature }
          : this.options.temperature !== undefined
            ? { temperature: this.options.temperature }
            : {}),
        ...(options?.maxTokens !== undefined
          ? { maxTokens: options.maxTokens }
          : this.options.maxTokens !== undefined
            ? { maxTokens: this.options.maxTokens }
            : {}),
        ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });

      const endTime = performance.now();
      const e2eLatencyMs = endTime - startTime;

      // Extract tool calls
      const toolCalls = extractToolCalls(result as GenerateTextResult);

      // Convert to ToolCallWithMetadata
      const toolCallsWithMetadata: ToolCallWithMetadata[] = toolCalls.map(
        (tc) => ({
          toolName: tc.toolName,
          arguments: tc.arguments,
        }),
      );

      return new QueryResult({
        query: prompt,
        response: result.text ?? "",
        toolCalls: toolCallsWithMetadata,
        usage: {
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
          totalTokens: result.usage?.totalTokens,
        },
        e2eLatencyMs,
        success: true,
      });
    } catch (error) {
      const endTime = performance.now();
      const e2eLatencyMs = endTime - startTime;

      return new QueryResult({
        query: prompt,
        response: "",
        toolCalls: [],
        usage: {},
        e2eLatencyMs,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Gets the tools to use for queries.
   * Handles both MCPClientManager and pre-built ToolSet.
   */
  private async getTools(): Promise<ToolSet> {
    if (this.options.tools instanceof MCPClientManager) {
      return await this.options.tools.getToolsForAiSdk(this.options.serverIds);
    }
    return this.options.tools;
  }

  /**
   * Gets the current configuration.
   */
  get config(): TestAgentConfig {
    return {
      llm: this.options.llm,
      apiKey: this.options.apiKey,
      systemPrompt: this.options.systemPrompt,
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
      serverIds: this.options.serverIds,
    };
  }

  /**
   * Creates a new TestAgent with modified options.
   *
   * @param overrides - Options to override
   * @returns New TestAgent instance
   *
   * @example
   * ```typescript
   * const variantAgent = agent.withOptions({
   *   temperature: 0.5,
   *   systemPrompt: "Be concise.",
   * });
   * ```
   */
  withOptions(overrides: Partial<TestAgentOptions>): TestAgent {
    return new TestAgent({
      ...this.options,
      ...overrides,
    });
  }
}
