import type { StopCondition, ToolSet } from "ai";
import type { PromptResult } from "./PromptResult.js";

/**
 * Options for the prompt() method
 */
export interface PromptOptions {
  /** Previous PromptResult(s) to include as conversation context for multi-turn conversations */
  context?: PromptResult | PromptResult[];

  /**
   * Additional AI SDK stop conditions for the agentic loop.
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
