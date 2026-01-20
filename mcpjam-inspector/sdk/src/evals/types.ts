/**
 * @mcpjam/sdk/evals - Type definitions for MCP server evaluations
 */

// ============================================================================
// Validator Types
// ============================================================================

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

// ============================================================================
// Tool Call Types (aligned with shared/eval-matching.ts and backend schema)
// ============================================================================

/**
 * Represents a single tool call.
 * Aligned with shared/eval-matching.ts ToolCall type.
 */
export interface ToolCall {
  /** The name of the tool that was called */
  toolName: string;

  /** The arguments passed to the tool */
  arguments: Record<string, unknown>;
}

/**
 * Extended tool call with execution metadata.
 * Used for detailed query results.
 */
export interface ToolCallWithMetadata extends ToolCall {
  /** The result returned by the tool (if available) */
  result?: unknown;

  /** Duration of the tool call in milliseconds */
  durationMs?: number;

  /** Error message if the tool call failed */
  error?: string;
}

/**
 * Argument mismatch details when tool was called with wrong arguments.
 * Aligned with shared/eval-matching.ts ArgumentMismatch type.
 */
export interface ArgumentMismatch {
  /** The tool name */
  toolName: string;

  /** The expected arguments */
  expectedArgs: Record<string, unknown>;

  /** The actual arguments that were passed */
  actualArgs: Record<string, unknown>;
}

/**
 * Result from matching expected vs actual tool calls.
 * Aligned with shared/eval-matching.ts ToolCallMatchResult type.
 */
export interface ToolCallMatchResult {
  /** Expected calls that were not made */
  missing: ToolCall[];

  /** Actual calls that were not expected */
  unexpected: ToolCall[];

  /** Calls where tool was correct but arguments mismatched */
  argumentMismatches: ArgumentMismatch[];

  /** Whether the match passed (no missing, no argument mismatches) */
  passed: boolean;
}

// ============================================================================
// Test Case Types (aligned with backend schema and client types)
// ============================================================================

/**
 * Expected tool call for test configuration.
 * Aligned with client/src/components/evals/eval-runner/types.ts ExpectedToolCall.
 */
export interface ExpectedToolCall {
  /** The tool name expected to be called */
  toolName: string;

  /** Expected arguments (partial match - actual may have more) */
  arguments: Record<string, unknown>;
}

/**
 * Test case definition for eval configurations.
 * Aligned with backend testCase schema and client TestTemplate.
 */
export interface TestCase {
  /** Human-readable title for the test case */
  title: string;

  /** The query/prompt to send to the LLM (named 'query' to match backend) */
  query: string;

  /** Number of iterations to run for this test */
  runs: number;

  /** List of expected tool calls */
  expectedToolCalls: ExpectedToolCall[];

  /** When true, test passes if NO tools are called (aligned with backend) */
  isNegativeTest?: boolean;

  /** Description of why app should NOT trigger (negative tests only) */
  scenario?: string;

  /** The expected output or experience from the MCP server */
  expectedOutput?: string;

  /** Validators to use for comparing expected vs actual results */
  validators?: Validator[];

  /** Classification of the prompt type for analysis */
  promptType?: PromptType;

  /** Category for grouping related test cases */
  category?: string;

  /** Tags for filtering and organization */
  tags?: string[];

  /** Advanced configuration options */
  advancedConfig?: Record<string, unknown>;
}

/**
 * Model configuration for test cases.
 * Aligned with backend testCase.models schema.
 */
export interface ModelConfig {
  /** Model identifier (e.g., "gpt-4o", "claude-3-opus") */
  model: string;

  /** Provider identifier (e.g., "openai", "anthropic") */
  provider: string;
}

// ============================================================================
// Token Usage Types (aligned with server/services/evals/types.ts)
// ============================================================================

/**
 * Token usage statistics from the LLM.
 * Aligned with server UsageTotals type.
 */
export interface Usage {
  /** Tokens used for the input/prompt */
  inputTokens?: number;

  /** Tokens used for the output/completion */
  outputTokens?: number;

  /** Total tokens used */
  totalTokens?: number;
}

// ============================================================================
// Evaluation Result Types (aligned with server/services/evals/types.ts)
// ============================================================================

/**
 * Result from evaluating expected vs actual tool calls.
 * Aligned with server EvaluationResult type.
 */
export interface EvaluationResult {
  /** Expected tool calls from the test case */
  expectedToolCalls: ToolCall[];

  /** Actual tools that were called */
  toolsCalled: ToolCall[];

  /** Expected calls that were not made */
  missing: ToolCall[];

  /** Actual calls that were not expected */
  unexpected: ToolCall[];

  /** Calls where tool was correct but arguments mismatched */
  argumentMismatches: ArgumentMismatch[];

  /** Whether the evaluation passed */
  passed: boolean;
}

// ============================================================================
// Query Result Types
// ============================================================================

/**
 * Result from a single query execution via TestAgent.
 */
export interface QueryResult {
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
  llmLatencyMs: number;

  /** MCP server latency in milliseconds (sum of all tool calls) */
  mcpLatencyMs: number;

  /** Whether the query completed successfully */
  success: boolean;

  /** Error message if the query failed */
  error?: string;
}

// ============================================================================
// Validation Types
// ============================================================================

/**
 * Result from validating expected vs actual using validators.
 */
export interface ValidationResult {
  /** Whether all validators passed */
  passed: boolean;

  /** Individual results per validator */
  details: Partial<Record<Validator, boolean>>;

  /** Optional explanation of failures */
  failureReasons?: string[];
}

/**
 * Expected values for validation.
 */
export interface ExpectedValues {
  /** Expected tool calls */
  tools: ExpectedToolCall[];

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
  toolNames: string[];

  /** Full tool call details */
  toolCalls: ToolCall[];
}

// ============================================================================
// Iteration and Suite Result Types (aligned with backend schema)
// ============================================================================

/**
 * Status of a test iteration.
 * Aligned with backend testIteration.status.
 */
export type IterationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Result of a test iteration.
 * Aligned with backend testIteration.result.
 */
export type IterationResultStatus =
  | "pending"
  | "passed"
  | "failed"
  | "cancelled";

/**
 * Result from running an evaluation iteration.
 * Aligned with backend testIteration schema.
 */
export interface IterationResult {
  /** Iteration number (1-indexed, matching backend) */
  iterationNumber: number;

  /** Current status of the iteration */
  status: IterationStatus;

  /** Result of the iteration (pass/fail) */
  result: IterationResultStatus;

  /** The query result from this iteration */
  queryResult?: QueryResult;

  /** Actual tool calls made */
  actualToolCalls: ToolCall[];

  /** Total tokens used */
  tokensUsed: number;

  /** Timestamp when iteration was created */
  createdAt: number;

  /** Timestamp when iteration started */
  startedAt?: number;

  /** Timestamp when iteration was last updated */
  updatedAt: number;

  /** Error message if iteration failed */
  error?: string;

  /** Detailed error information */
  errorDetails?: string;
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
 * Summary statistics for a test suite run.
 * Aligned with backend testSuiteRun.summary.
 */
export interface SuiteRunSummary {
  /** Total number of iterations */
  total: number;

  /** Number of passed iterations */
  passed: number;

  /** Number of failed iterations */
  failed: number;

  /** Pass rate as a percentage (0-100) */
  passRate: number;
}

/**
 * Pass criteria for determining if a suite run passed.
 * Aligned with backend testSuiteRun.passCriteria.
 */
export interface PassCriteria {
  /** Minimum pass rate percentage required (0-100) */
  minimumPassRate: number;
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

  /** Summary statistics */
  summary: SuiteRunSummary;

  /** Pass criteria used */
  passCriteria?: PassCriteria;

  /** Overall result of the suite run */
  result: IterationResultStatus;

  /** Start time of the suite run (Unix timestamp) */
  startedAt: number;

  /** End time of the suite run (Unix timestamp) */
  completedAt?: number;

  /** Total duration in milliseconds */
  durationMs?: number;
}

// ============================================================================
// Configuration Types
// ============================================================================

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

  /** Number of iterations to run per test */
  iterations?: number;

  /** Maximum concurrent iterations */
  concurrency?: number;

  /** Maximum retries per iteration on failure */
  maxRetries?: number;

  /** Timeout per iteration in milliseconds */
  timeoutMs?: number;

  /** Pass criteria for determining suite success */
  passCriteria?: PassCriteria;
}

/**
 * Environment configuration for test suite.
 * Aligned with backend testSuite.environment.
 */
export interface EnvironmentConfig {
  /** Server IDs to use for this suite */
  servers: string[];
}

// ============================================================================
// Function Types
// ============================================================================

/**
 * Function type for eval iteration - must return boolean indicating pass/fail.
 */
export type EvalIterationFn = () => Promise<boolean> | boolean;

/**
 * Function type for eval iteration with result - returns detailed result.
 */
export type EvalIterationWithResultFn = () =>
  | Promise<IterationResult>
  | IterationResult;
