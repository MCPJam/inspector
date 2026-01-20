/**
 * @mcpjam/sdk/evals - MCP Server Evaluations
 *
 * This module provides utilities for evaluating MCP server "tool ergonomics" -
 * measuring how well an LLM understands and uses your MCP server's tools.
 *
 * @example
 * ```typescript
 * import { TestAgent, EvalsSuite } from "@mcpjam/sdk/evals";
 *
 * const agent = new TestAgent({
 *   tools: manager,
 *   llm: "openai/gpt-4o",
 *   apiKey: process.env.OPENAI_API_KEY,
 * });
 *
 * const suite = new EvalsSuite({ iterations: 30 });
 * const results = await suite.run({
 *   func: async () => {
 *     const result = await agent.query("Create a project");
 *     return result.toolsCalled().includes("create_project");
 *   }
 * });
 *
 * console.log(`Accuracy: ${results.accuracy()}`);
 * ```
 */

// Export all types
export type {
  // Validator types
  Validator,
  PromptType,

  // Tool call types (aligned with shared/eval-matching.ts)
  ToolCall,
  ToolCallWithMetadata,
  ArgumentMismatch,
  ToolCallMatchResult,

  // Test case types (aligned with backend and client)
  ExpectedToolCall,
  TestCase,
  ModelConfig,

  // Token usage (aligned with server types)
  Usage,

  // Evaluation result (aligned with server types)
  EvaluationResult,

  // Query result
  QueryResult,

  // Validation types
  ValidationResult,
  ExpectedValues,
  ActualValues,

  // Iteration types (aligned with backend schema)
  IterationStatus,
  IterationResultStatus,
  IterationResult,

  // Suite result types (aligned with backend schema)
  LatencyMetrics,
  SuiteRunSummary,
  PassCriteria,
  RetryDistribution,
  EvalsSuiteResult,

  // Configuration types
  TestAgentConfig,
  EvalsSuiteConfig,
  EnvironmentConfig,

  // Function types
  EvalIterationFn,
  EvalIterationWithResultFn,
} from "./types.js";

// Placeholder exports for classes that will be implemented in later phases
// These are commented out until implementation:
// export { TestAgent } from "./test-agent.js";
// export { EvalsSuite } from "./evals-suite.js";
// export { validate } from "./validators/index.js";
// export { matchToolCalls, argumentsMatch } from "./validators/tool-matching.js";
