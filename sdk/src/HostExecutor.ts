import type { StopCondition, TimeoutConfiguration, ToolSet } from "ai";
import type { PromptResult } from "./PromptResult.js";
import type { MCPServerReplayConfig } from "./eval-reporting-types.js";

/**
 * Options for the run() method
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
   * const result = await executor.run("Find my tasks", {
   *   stopWhen: hasToolCall("search_tasks"),
   * });
   * expect(result.hasToolCall("search_tasks")).toBe(true);
   *
   * // Multiple conditions (any one being true stops the loop)
   * const result = await executor.run("Do something", {
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
 * Minimal executor interface that eval tests run against. Implemented by
 * `HostRunner` (sync, tools pre-resolved) and `HostRuntime` (live binding
 * to a manager). Use `HostRunner.mock()` for deterministic tests without
 * an unsafe `as unknown as HostRunner` cast.
 */
export interface HostExecutor {
  run(message: string, options?: PromptOptions): Promise<PromptResult>;
  withOptions(options: Record<string, any>): HostExecutor;
  getPromptHistory(): PromptResult[];
  resetPromptHistory(): void;
  /**
   * Returns the immutable `HostJson` snapshot driving this executor, if it
   * was constructed from a `Host`. Optional because callers can also build
   * an executor without supplying a `Host` (legacy explicit-config path).
   */
  getHostSnapshot?(): import("./host-config/public-types.js").HostJson | undefined;
  /**
   * Returns replay configs for the executor's attached MCP servers.
   * Optional — `HostRunner` and `HostRuntime` expose it when their
   * underlying manager supports it, so SDK eval uploads can infer
   * replay configs without callers manually copying them into
   * `mcpjam.serverReplayConfigs`.
   */
  getServerReplayConfigs?(): MCPServerReplayConfig[] | undefined;
}
