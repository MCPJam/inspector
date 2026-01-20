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

  // Test case and configuration
  TestCase,
  TestAgentConfig,
  EvalsSuiteConfig,

  // Tool call related
  ToolCall,
  Usage,

  // Query and validation results
  QueryResult,
  ValidationResult,
  ExpectedValues,
  ActualValues,

  // Iteration and suite results
  IterationResult,
  EvalsSuiteResult,
  RetryDistribution,

  // Latency metrics
  LatencyMetrics,

  // Function types
  EvalIterationFn,
  EvalIterationWithResultFn,
} from "./types.js";

// Placeholder exports for classes that will be implemented in later phases
// These are commented out until implementation:
// export { TestAgent } from "./test-agent.js";
// export { EvalsSuite } from "./evals-suite.js";
// export { validate } from "./validators/index.js";
