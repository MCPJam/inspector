/**
 * QueryResult class that wraps the result of a TestAgent query with helper methods.
 *
 * Provides convenient methods for accessing and analyzing tool calls, usage, and latency.
 */

import type {
  ToolCall,
  ToolCallWithMetadata,
  Usage,
  QueryResult as QueryResultInterface,
} from "./types.js";

/**
 * Options for creating a QueryResult instance.
 */
export interface QueryResultOptions {
  /** The original query that was sent */
  query: string;

  /** The LLM's text response */
  response: string;

  /** List of tool calls made during the query */
  toolCalls: ToolCallWithMetadata[];

  /** Token usage for this query */
  usage: Usage;

  /** Total end-to-end latency in milliseconds */
  e2eLatencyMs: number;

  /** LLM API latency in milliseconds */
  llmLatencyMs?: number;

  /** MCP server latency in milliseconds (sum of all tool calls) */
  mcpLatencyMs?: number;

  /** Whether the query completed successfully */
  success: boolean;

  /** Error message if the query failed */
  error?: string;
}

/**
 * Wraps the result of a TestAgent query with convenient helper methods.
 *
 * @example
 * ```typescript
 * const result = await agent.query("Create a project called 'Onboard Joe'");
 *
 * // Check what tools were called
 * result.toolsCalled();       // ["create_project"]
 * result.hasToolCall("create_project"); // true
 *
 * // Check tool call arguments
 * result.hasToolCalls([
 *   { toolName: "create_project", arguments: { name: "Onboard Joe" } }
 * ]); // true
 *
 * // Get usage info
 * result.usage.totalTokens;   // 1234
 * ```
 */
export class QueryResult implements QueryResultInterface {
  readonly query: string;
  readonly response: string;
  readonly toolCalls: ToolCallWithMetadata[];
  readonly usage: Usage;
  readonly e2eLatencyMs: number;
  readonly llmLatencyMs: number;
  readonly mcpLatencyMs: number;
  readonly success: boolean;
  readonly error?: string;

  constructor(options: QueryResultOptions) {
    this.query = options.query;
    this.response = options.response;
    this.toolCalls = options.toolCalls;
    this.usage = options.usage;
    this.e2eLatencyMs = options.e2eLatencyMs;
    this.llmLatencyMs = options.llmLatencyMs ?? 0;
    this.mcpLatencyMs = options.mcpLatencyMs ?? this.calculateMcpLatency();
    this.success = options.success;
    this.error = options.error;
  }

  /**
   * Returns an array of tool names that were called during this query.
   *
   * @returns Array of tool names in order of execution
   *
   * @example
   * ```typescript
   * const names = result.toolsCalled();
   * // ["search_tasks", "update_task"]
   * ```
   */
  toolsCalled(): string[] {
    return this.toolCalls.map((tc) => tc.toolName);
  }

  /**
   * Returns unique tool names that were called during this query.
   *
   * @returns Array of unique tool names
   *
   * @example
   * ```typescript
   * // If search_tasks was called twice:
   * const unique = result.uniqueToolsCalled();
   * // ["search_tasks", "update_task"]
   * ```
   */
  uniqueToolsCalled(): string[] {
    return [...new Set(this.toolsCalled())];
  }

  /**
   * Checks if a specific tool was called.
   *
   * @param toolName - Name of the tool to check
   * @returns True if the tool was called at least once
   *
   * @example
   * ```typescript
   * if (result.hasToolCall("create_project")) {
   *   console.log("Project was created!");
   * }
   * ```
   */
  hasToolCall(toolName: string): boolean {
    return this.toolCalls.some((tc) => tc.toolName === toolName);
  }

  /**
   * Checks if all the expected tool calls were made.
   * This performs a subset check - actual calls may include additional tools.
   *
   * @param expected - Array of expected tool calls to check
   * @returns True if all expected tools were called with matching arguments
   *
   * @example
   * ```typescript
   * const passed = result.hasToolCalls([
   *   { toolName: "create_project", arguments: { name: "Onboard Joe" } },
   * ]);
   * ```
   */
  hasToolCalls(expected: ToolCall[]): boolean {
    for (const exp of expected) {
      const found = this.toolCalls.some((actual) =>
        this.matchToolCall(exp, actual),
      );
      if (!found) {
        return false;
      }
    }
    return true;
  }

  /**
   * Checks if the exact set of tools were called (no more, no less).
   *
   * @param expectedNames - Array of expected tool names
   * @returns True if exactly these tools were called (in any order)
   *
   * @example
   * ```typescript
   * const exact = result.hasExactToolCalls(["search_tasks", "update_task"]);
   * ```
   */
  hasExactToolCalls(expectedNames: string[]): boolean {
    const actualNames = this.uniqueToolsCalled();
    if (actualNames.length !== expectedNames.length) {
      return false;
    }
    const expectedSet = new Set(expectedNames);
    return actualNames.every((name) => expectedSet.has(name));
  }

  /**
   * Gets all tool calls that match a specific tool name.
   *
   * @param toolName - Name of the tool to filter by
   * @returns Array of tool calls matching the name
   *
   * @example
   * ```typescript
   * const searchCalls = result.getToolCallsByName("search_tasks");
   * // [{ toolName: "search_tasks", arguments: { query: "bug" } }, ...]
   * ```
   */
  getToolCallsByName(toolName: string): ToolCallWithMetadata[] {
    return this.toolCalls.filter((tc) => tc.toolName === toolName);
  }

  /**
   * Gets the first tool call that matches a specific tool name.
   *
   * @param toolName - Name of the tool to find
   * @returns The first matching tool call or undefined
   *
   * @example
   * ```typescript
   * const createCall = result.getFirstToolCall("create_project");
   * if (createCall) {
   *   console.log("Project name:", createCall.arguments.name);
   * }
   * ```
   */
  getFirstToolCall(toolName: string): ToolCallWithMetadata | undefined {
    return this.toolCalls.find((tc) => tc.toolName === toolName);
  }

  /**
   * Gets the total number of tool calls made.
   *
   * @returns Count of all tool calls
   */
  toolCallCount(): number {
    return this.toolCalls.length;
  }

  /**
   * Checks if any tools were called.
   *
   * @returns True if at least one tool was called
   */
  hasAnyToolCalls(): boolean {
    return this.toolCalls.length > 0;
  }

  /**
   * Checks if no tools were called.
   *
   * @returns True if no tools were called
   */
  hasNoToolCalls(): boolean {
    return this.toolCalls.length === 0;
  }

  /**
   * Gets the total token count from usage.
   *
   * @returns Total tokens used, or 0 if not available
   */
  totalTokens(): number {
    return this.usage.totalTokens ?? 0;
  }

  /**
   * Gets the input token count from usage.
   *
   * @returns Input tokens used, or 0 if not available
   */
  inputTokens(): number {
    return this.usage.inputTokens ?? 0;
  }

  /**
   * Gets the output token count from usage.
   *
   * @returns Output tokens used, or 0 if not available
   */
  outputTokens(): number {
    return this.usage.outputTokens ?? 0;
  }

  /**
   * Converts the QueryResult to a plain object (for serialization).
   *
   * @returns Plain object representation
   */
  toJSON(): QueryResultInterface {
    return {
      query: this.query,
      response: this.response,
      toolCalls: this.toolCalls,
      usage: this.usage,
      e2eLatencyMs: this.e2eLatencyMs,
      llmLatencyMs: this.llmLatencyMs,
      mcpLatencyMs: this.mcpLatencyMs,
      success: this.success,
      error: this.error,
    };
  }

  /**
   * Calculates MCP latency by summing tool call durations.
   */
  private calculateMcpLatency(): number {
    return this.toolCalls.reduce((sum, tc) => sum + (tc.durationMs ?? 0), 0);
  }

  /**
   * Checks if an expected tool call matches an actual tool call.
   * Arguments are checked as a subset match.
   */
  private matchToolCall(
    expected: ToolCall,
    actual: ToolCallWithMetadata,
  ): boolean {
    if (expected.toolName !== actual.toolName) {
      return false;
    }

    // Check if all expected arguments are present in actual
    for (const [key, expectedValue] of Object.entries(expected.arguments)) {
      const actualValue = actual.arguments[key];
      if (!this.valuesMatch(expectedValue, actualValue)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Deep equality check for values.
   */
  private valuesMatch(expected: unknown, actual: unknown): boolean {
    if (expected === actual) {
      return true;
    }

    if (typeof expected !== typeof actual) {
      return false;
    }

    if (expected === null || actual === null) {
      return expected === actual;
    }

    if (Array.isArray(expected) && Array.isArray(actual)) {
      if (expected.length !== actual.length) {
        return false;
      }
      return expected.every((exp, i) => this.valuesMatch(exp, actual[i]));
    }

    if (typeof expected === "object" && typeof actual === "object") {
      const expectedObj = expected as Record<string, unknown>;
      const actualObj = actual as Record<string, unknown>;
      const expectedKeys = Object.keys(expectedObj);
      return expectedKeys.every((key) =>
        this.valuesMatch(expectedObj[key], actualObj[key]),
      );
    }

    return false;
  }
}
