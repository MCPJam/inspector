/**
 * PromptResult class - wraps the result of a TestAgent prompt
 */

import type {
  ToolCall,
  TokenUsage,
  PromptResultData,
  LatencyBreakdown,
  CoreMessage,
  CoreUserMessage,
  CoreAssistantMessage,
  CoreToolMessage,
} from "./types.js";
import type {
  EvalResultInput,
  EvalWidgetSnapshotInput,
  EvalTraceSpanInput,
} from "./eval-reporting-types.js";
import { finalizePassedForEval } from "./eval-tool-execution.js";

/**
 * Represents the result of a TestAgent prompt.
 * Provides convenient methods to inspect tool calls, token usage, and errors.
 */
export class PromptResult {
  /** The original prompt/query that was sent */
  readonly prompt: string;

  /** The text response from the LLM */
  readonly text: string;

  /** The full conversation history */
  private readonly _messages: CoreMessage[];

  /** Latency breakdown (e2e, llm, mcp) */
  private readonly _latency: LatencyBreakdown;

  /** Tool calls made during the prompt */
  private readonly _toolCalls: ToolCall[];

  /** Token usage statistics */
  private readonly _usage: TokenUsage;

  /** Widget snapshots captured during tool execution */
  private readonly _widgetSnapshots: EvalWidgetSnapshotInput[];

  /** Error message if the prompt failed */
  private readonly _error?: string;

  /** LLM provider name (e.g., "openai", "anthropic") */
  private readonly _provider?: string;

  /** LLM model name (e.g., "gpt-4o", "claude-3-5-sonnet-20241022") */
  private readonly _model?: string;

  /** Timeline spans (times relative to prompt run start) */
  private readonly _spans: EvalTraceSpanInput[];

  /**
   * Create a new PromptResult
   * @param data - The raw prompt result data
   */
  constructor(data: PromptResultData) {
    this.prompt = data.prompt;
    this._messages = data.messages;
    this.text = data.text;
    this._latency = data.latency;
    this._toolCalls = data.toolCalls;
    this._usage = data.usage;
    this._widgetSnapshots = data.widgetSnapshots ?? [];
    this._error = data.error;
    this._provider = data.provider;
    this._model = data.model;
    this._spans = data.spans ?? [];
  }

  /**
   * Get the original query/prompt that was sent.
   *
   * @returns The original prompt string
   */
  getPrompt(): string {
    return this.prompt;
  }

  /**
   * Get the full conversation history (user, assistant, tool messages).
   * Returns a copy to prevent external modification.
   *
   * @returns Array of CoreMessage objects
   */
  getMessages(): CoreMessage[] {
    return [...this._messages];
  }

  /**
   * Get only user messages from the conversation.
   *
   * @returns Array of CoreUserMessage objects
   */
  getUserMessages(): CoreUserMessage[] {
    return this._messages.filter(
      (m): m is CoreUserMessage => m.role === "user"
    );
  }

  /**
   * Get only assistant messages from the conversation.
   *
   * @returns Array of CoreAssistantMessage objects
   */
  getAssistantMessages(): CoreAssistantMessage[] {
    return this._messages.filter(
      (m): m is CoreAssistantMessage => m.role === "assistant"
    );
  }

  /**
   * Get only tool result messages from the conversation.
   *
   * @returns Array of CoreToolMessage objects
   */
  getToolMessages(): CoreToolMessage[] {
    return this._messages.filter(
      (m): m is CoreToolMessage => m.role === "tool"
    );
  }

  /**
   * Get the end-to-end latency in milliseconds.
   * This is the total wall-clock time for the prompt.
   *
   * @returns End-to-end latency in milliseconds
   */
  e2eLatencyMs(): number {
    return this._latency.e2eMs;
  }

  /**
   * Get the LLM API latency in milliseconds.
   * This is the time spent waiting for LLM responses (excluding tool execution).
   *
   * @returns LLM latency in milliseconds
   */
  llmLatencyMs(): number {
    return this._latency.llmMs;
  }

  /**
   * Get the MCP tool execution latency in milliseconds.
   * This is the time spent executing MCP tools.
   *
   * @returns MCP tool latency in milliseconds
   */
  mcpLatencyMs(): number {
    return this._latency.mcpMs;
  }

  /**
   * Get the full latency breakdown.
   *
   * @returns LatencyBreakdown object with e2eMs, llmMs, and mcpMs
   */
  getLatency(): LatencyBreakdown {
    return { ...this._latency };
  }

  /**
   * Get the names of all tools that were called during this prompt.
   * Returns a standard string[] that can be used with .includes().
   *
   * @returns Array of tool names
   */
  toolsCalled(): string[] {
    return this._toolCalls.map((tc) => tc.toolName);
  }

  /**
   * Check if a specific tool was called during this prompt.
   * Case-sensitive exact match.
   *
   * @param toolName - The name of the tool to check for
   * @returns true if the tool was called
   */
  hasToolCall(toolName: string): boolean {
    return this._toolCalls.some((tc) => tc.toolName === toolName);
  }

  /**
   * Get all tool calls with their arguments.
   *
   * @returns Array of ToolCall objects
   */
  getToolCalls(): ToolCall[] {
    return [...this._toolCalls];
  }

  /**
   * Get the arguments passed to a specific tool call.
   * Returns undefined if the tool was not called.
   * If the tool was called multiple times, returns the first call's arguments.
   *
   * @param toolName - The name of the tool
   * @returns The arguments object or undefined
   */
  getToolArguments(toolName: string): Record<string, unknown> | undefined {
    const call = this._toolCalls.find((tc) => tc.toolName === toolName);
    return call?.arguments;
  }

  /**
   * Get the total number of tokens used.
   *
   * @returns Total tokens (input + output)
   */
  totalTokens(): number {
    return this._usage.totalTokens;
  }

  /**
   * Get the number of input tokens used.
   *
   * @returns Input token count
   */
  inputTokens(): number {
    return this._usage.inputTokens;
  }

  /**
   * Get the number of output tokens used.
   *
   * @returns Output token count
   */
  outputTokens(): number {
    return this._usage.outputTokens;
  }

  /**
   * Get the full token usage statistics.
   *
   * @returns TokenUsage object
   */
  getUsage(): TokenUsage {
    return { ...this._usage };
  }

  /**
   * Get widget snapshots captured during tool execution.
   */
  getWidgetSnapshots(): EvalWidgetSnapshotInput[] {
    return [...this._widgetSnapshots];
  }

  /**
   * Timeline spans for this prompt (e.g. step / llm / tool / error), if captured.
   */
  getSpans(): EvalTraceSpanInput[] {
    return [...this._spans];
  }

  /**
   * Check if this prompt resulted in an error.
   *
   * @returns true if there was an error
   */
  hasError(): boolean {
    return this._error !== undefined;
  }

  /**
   * Get the error message if the prompt failed.
   *
   * @returns The error message or undefined
   */
  getError(): string | undefined {
    return this._error;
  }

  /**
   * Get the LLM provider name.
   *
   * @returns The provider name or undefined
   */
  getProvider(): string | undefined {
    return this._provider;
  }

  /**
   * Get the LLM model name.
   *
   * @returns The model name or undefined
   */
  getModel(): string | undefined {
    return this._model;
  }

  /**
   * Create a PromptResult from raw data.
   * Factory method for convenience.
   *
   * @param data - The raw prompt result data
   * @returns A new PromptResult instance
   */
  static from(data: PromptResultData): PromptResult {
    return new PromptResult(data);
  }

  /**
   * Create an error PromptResult.
   * Factory method for error cases.
   *
   * @param error - The error message
   * @param latency - The latency breakdown or e2e time in milliseconds
   * @returns A new PromptResult instance with error state
   */
  static error(
    error: string,
    latency: LatencyBreakdown | number = 0,
    prompt: string = "",
    metadata?: {
      provider?: string;
      model?: string;
      spans?: EvalTraceSpanInput[];
    }
  ): PromptResult {
    const latencyBreakdown: LatencyBreakdown =
      typeof latency === "number"
        ? { e2eMs: latency, llmMs: 0, mcpMs: 0 }
        : latency;

    return new PromptResult({
      prompt,
      messages: [],
      text: "",
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      latency: latencyBreakdown,
      error,
      provider: metadata?.provider,
      model: metadata?.model,
      spans: metadata?.spans,
    });
  }

  /**
   * Format the conversation trace as a JSON string.
   * Useful for debugging failed evaluations.
   *
   * @returns A JSON string of the conversation messages
   */
  formatTrace(): string {
    return JSON.stringify(this._messages, null, 2);
  }

  /**
   * Convert this prompt result into an EvalResultInput for report ingestion.
   */
  toEvalResult(
    options?: Partial<
      Omit<EvalResultInput, "actualToolCalls" | "tokens" | "trace">
    > & { failOnToolError?: boolean }
  ): EvalResultInput {
    const caseTitle =
      options?.caseTitle ??
      (this.prompt.trim().length > 0 ? this.prompt : "PromptResult");
    const usage = this.getUsage();
    const trace: EvalResultInput["trace"] = {
      messages: this.getMessages() as any[],
      ...(this._spans.length > 0 ? { spans: this.getSpans() } : {}),
    };

    const matchPassed =
      typeof options?.passed === "boolean" ? options.passed : !this.hasError();

    const passed = finalizePassedForEval({
      matchPassed,
      trace,
      iterationError: options?.error ?? this.getError(),
      failOnToolError: options?.failOnToolError,
    });

    return {
      caseTitle,
      query: options?.query ?? this.prompt,
      passed,
      durationMs: options?.durationMs ?? this.e2eLatencyMs(),
      provider: options?.provider ?? this._provider,
      model: options?.model ?? this._model,
      expectedToolCalls: options?.expectedToolCalls,
      actualToolCalls: this.getToolCalls().map((toolCall) => ({
        toolName: toolCall.toolName,
        arguments: toolCall.arguments,
      })),
      tokens: {
        input: usage.inputTokens,
        output: usage.outputTokens,
        total: usage.totalTokens,
      },
      error: options?.error ?? this.getError(),
      errorDetails: options?.errorDetails,
      trace,
      externalIterationId: options?.externalIterationId,
      externalCaseId: options?.externalCaseId,
      metadata: options?.metadata,
      isNegativeTest: options?.isNegativeTest,
      advancedConfig: options?.advancedConfig,
      widgetSnapshots: options?.widgetSnapshots ?? this.getWidgetSnapshots(),
    };
  }
}
