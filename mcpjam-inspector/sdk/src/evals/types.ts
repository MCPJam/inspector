/**
 * @mcpjam/sdk/evals - Type definitions for MCP server evaluations
 */

/**
 * Validator types for comparing expected vs actual tool calls.
 *
 * - `tool_name`: Exact match - expected_tools == actual_tools
 * - `tool_subset`: Subset match - expected_tools ⊆ actual_tools (allows extra tools)
 * - `call_sequence`: Subsequence match - expected_sequence appears as subsequence in actual
 * - `strict_sequence`: Exact order - expected_sequence == actual call order exactly
 * - `param_match`: Param subset - actual params contain all expected params
 * - `param_exact`: Exact params - actual params == expected exactly (no extra allowed)
 */
export type Validator =
  | "tool_name"
  | "tool_subset"
  | "call_sequence"
  | "strict_sequence"
  | "param_match"
  | "param_exact";

/**
 * Prompt type classification for evaluation analysis.
 *
 * - `direct`: Explicit request to use a specific tool
 * - `indirect`: Implicit request that should trigger tool usage
 * - `negative`: Request that should NOT trigger the expected tool
 */
export type PromptType = "direct" | "indirect" | "negative";

/**
 * Test case definition for eval configurations.
 */
export interface TestCase {
  /** Human-readable title for the test case */
  title: string;

  /** The prompt to send to the LLM */
  prompt: string;

  /** List of tool names expected to be called */
  expectedTools: string[];

  /** Validators to use for comparing expected vs actual results */
  validators: Validator[];

  /** Expected call sequence for sequence validators */
  expectedSequence?: string[];

  /** Expected parameters for param validators. Map of toolName -> params */
  expectedParams?: Record<string, Record<string, unknown>>;

  /** Classification of the prompt type for analysis */
  promptType?: PromptType;

  /** Category for grouping related test cases */
  category?: string;

  /** Tags for filtering and organization */
  tags?: string[];
}

/**
 * Represents a single tool call made by the LLM.
 */
export interface ToolCall {
  /** The name of the tool that was called */
  toolName: string;

  /** The arguments passed to the tool */
  arguments: Record<string, unknown>;

  /** The result returned by the tool (if available) */
  result?: unknown;

  /** Duration of the tool call in milliseconds */
  durationMs?: number;
}

/**
 * Token usage statistics from the LLM.
 */
export interface Usage {
  /** Total tokens used (prompt + completion) */
  totalTokens: number;

  /** Tokens used for the prompt/input */
  promptTokens: number;

  /** Tokens used for the completion/output */
  completionTokens: number;
}

/**
 * Result from a single query execution via TestAgent.
 */
export interface QueryResult {
  /** The original prompt that was sent */
  prompt: string;

  /** The LLM's text response */
  response: string;

  /** List of tool calls made during the query */
  toolCalls: ToolCall[];

  /** Token usage for this query */
  usage: Usage;

  /** Total end-to-end latency in milliseconds */
  e2eLatencyMs: number;

  /** LLM API latency in milliseconds */
  llmLatencyMs: number;

  /** MCP server latency in milliseconds (sum of all tool calls) */
  mcpLatencyMs: number;

  /** Whether the query completed successfully */
  success: boolean;

  /** Error message if the query failed */
  error?: string;
}

/**
 * Result from validating expected vs actual tool calls.
 */
export interface ValidationResult {
  /** Whether all validators passed */
  passed: boolean;

  /** Individual results per validator */
  details: Record<Validator, boolean>;

  /** Optional explanation of failures */
  failureReasons?: string[];
}

/**
 * Expected values for validation.
 */
export interface ExpectedValues {
  /** Expected tool names */
  tools: string[];

  /** Expected call sequence (for sequence validators) */
  sequence?: string[];

  /** Expected parameters (for param validators) */
  params?: Record<string, Record<string, unknown>>;
}

/**
 * Actual values observed during test execution.
 */
export interface ActualValues {
  /** Actual tool names called */
  tools: string[];

  /** Full tool call details */
  toolCalls: ToolCall[];
}

/**
 * Latency metrics with percentiles.
 */
export interface LatencyMetrics {
  /** Minimum latency in milliseconds */
  min: number;

  /** Maximum latency in milliseconds */
  max: number;

  /** Mean/average latency in milliseconds */
  mean: number;

  /** 50th percentile (median) latency in milliseconds */
  p50: number;

  /** 95th percentile latency in milliseconds */
  p95: number;
}

/**
 * Result from running an evaluation iteration.
 */
export interface IterationResult {
  /** Iteration number (0-indexed) */
  iteration: number;

  /** Whether this iteration passed the test */
  passed: boolean;

  /** The query result from this iteration */
  queryResult: QueryResult;

  /** Validation result against expected values */
  validationResult: ValidationResult;

  /** Number of retries that occurred (if any) */
  retries: number;

  /** Timestamp when iteration completed */
  completedAt: Date;
}

/**
 * Retry distribution mapping retry count to number of occurrences.
 * e.g., { 0: 25, 1: 3, 2: 2 } means 25 succeeded first try, 3 needed 1 retry, 2 needed 2 retries
 */
export type RetryDistribution = Record<number, number>;

/**
 * Result from running an evaluation suite.
 */
export interface EvalsSuiteResult {
  /** Name of the eval suite */
  name: string;

  /** All iteration results */
  iterations: IterationResult[];

  /** Total number of iterations run */
  totalIterations: number;

  /** Number of iterations that passed */
  passedIterations: number;

  /** Number of iterations that failed */
  failedIterations: number;

  /** Start time of the suite run */
  startedAt: Date;

  /** End time of the suite run */
  completedAt: Date;

  /** Total duration in milliseconds */
  durationMs: number;
}

/**
 * Configuration for TestAgent.
 */
export interface TestAgentConfig {
  /** The LLM model to use (e.g., "openai/gpt-4o", "anthropic/claude-3-opus") */
  llm: string;

  /** API key for the LLM provider */
  apiKey: string;

  /** System prompt for the agent */
  systemPrompt?: string;

  /** Temperature for LLM sampling (0-2) */
  temperature?: number;

  /** Maximum tokens for response */
  maxTokens?: number;

  /** Server IDs to include tools from (if using MCPClientManager) */
  serverIds?: string[];
}

/**
 * Configuration for EvalsSuite.
 */
export interface EvalsSuiteConfig {
  /** Name of the eval suite (shown in MCPJam UI) */
  name?: string;

  /** Number of iterations to run */
  iterations?: number;

  /** Maximum concurrent iterations */
  concurrency?: number;

  /** Maximum retries per iteration on failure */
  maxRetries?: number;

  /** Timeout per iteration in milliseconds */
  timeoutMs?: number;
}

/**
 * Function type for eval iteration - must return boolean indicating pass/fail.
 */
export type EvalIterationFn = () => Promise<boolean> | boolean;

/**
 * Function type for eval iteration with result - returns detailed result.
 */
export type EvalIterationWithResultFn = () => Promise<IterationResult> | IterationResult;
