import type { StopCondition, TimeoutConfiguration, ToolSet } from "ai";
import type { PromptResult } from "./PromptResult.js";

/**
 * Options for the prompt() method
 */
export interface PromptOptions {
  /** Previous PromptResult(s) to include as conversation context for multi-turn conversations */
  context?: PromptResult | PromptResult[];

  /** Optional abort signal for cancelling the prompt runtime. */
  abortSignal?: AbortSignal;

  /**
   * Additional stop conditions for the agentic loop.
   * Evaluated after each step completes (tools execute normally).
   * `stepCountIs(maxSteps)` is always applied as a safety guard
   * in addition to any conditions provided here.
   *
   * Import helpers like `hasToolCall` and `stepCountIs` from `"@mcpjam/sdk"`.
   *
   * @example
   * ```typescript
   * import { hasToolCall } from "@mcpjam/sdk";
   *
   * // Stop the loop after the step where "search_tasks" is called
   * const result = await agent.prompt("Find my tasks", {
   *   stopWhen: hasToolCall("search_tasks"),
   * });
   * expect(result.hasToolCall("search_tasks")).toBe(true);
   *
   * // Multiple conditions (any one being true stops the loop)
   * const result = await agent.prompt("Do something", {
   *   stopWhen: [hasToolCall("tool_a"), hasToolCall("tool_b")],
   * });
   * ```
   */
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;

  /**
   * Timeout for the prompt runtime.
   *
   * - `number`: total timeout for the entire prompt call in milliseconds
   * - `{ totalMs }`: total timeout across all steps
   * - `{ stepMs }`: timeout for each generation step
   * - `{ chunkMs }`: accepted for parity and primarily relevant to streaming APIs
   *
   * The runtime creates an internal abort signal. Tools can stop early if they
   * respect the `abortSignal` passed to `execute()`.
   */
  timeout?: TimeoutConfiguration;

  /** Shortcut for a total prompt timeout in milliseconds. */
  timeoutMs?: number;

  /**
   * Stop the prompt loop after the step where one of these tools is called and
   * short-circuit that tool execution with a stub result.
   */
  stopAfterToolCall?: string | string[];
}

/**
 * Minimal agent interface for running eval tests.
 * TestAgent implements this; use TestAgent.mock() for deterministic tests
 * without the unsafe `as unknown as TestAgent` cast.
 */
export interface EvalAgent {
  prompt(message: string, options?: PromptOptions): Promise<PromptResult>;
  withOptions(options: Record<string, any>): EvalAgent;
  getPromptHistory(): PromptResult[];
  resetPromptHistory(): void;
}
