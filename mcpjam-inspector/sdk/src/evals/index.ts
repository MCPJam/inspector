/**
 * @mcpjam/sdk/evals - MCP Server Evaluations
 *
 * This module provides utilities for evaluating MCP server "tool ergonomics" -
 * measuring how well an LLM understands and uses your MCP server's tools.
 *
 * @example
 * ```typescript
 * import { TestAgent, EvalsSuite } from "@mcpjam/sdk/evals";
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
 * });
 *
 * const result = await agent.query("Create a project called 'Onboard Joe'");
 *
 * console.log(result.toolsCalled());     // ["asana_create_project"]
 * console.log(result.hasToolCall("asana_create_project")); // true
 * console.log(result.totalTokens());     // 1234
 * ```
 */

// =============================================================================
// Type Exports
// =============================================================================

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

  // Query result (type interface - use QueryResult class for instances)
  QueryResult as QueryResultInterface,

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

// =============================================================================
// Model Factory Exports (Phase 2)
// =============================================================================

export {
  createModel,
  createModelFromString,
  parseModelString,
  type ModelProvider,
  type ModelDefinition,
  type BaseUrls,
} from "./model-factory.js";

// =============================================================================
// Tool Extraction Exports (Phase 2)
// =============================================================================

export {
  extractToolCalls,
  extractToolNames,
  extractUniqueToolNames,
  type GenerateTextResult,
} from "./tool-extraction.js";

// =============================================================================
// QueryResult Export (Phase 2)
// =============================================================================

export { QueryResult, type QueryResultOptions } from "./query-result.js";

// =============================================================================
// TestAgent Export (Phase 2)
// =============================================================================

export { TestAgent, type TestAgentOptions } from "./test-agent.js";

// =============================================================================
// Future Exports (Phases 3-6)
// =============================================================================

// Placeholder exports for classes that will be implemented in later phases:
// export { EvalsSuite } from "./evals-suite.js";           // Phase 4
// export { validate } from "./validators/index.js";         // Phase 3
// export { matchToolCalls, argumentsMatch } from "./validators/tool-matching.js"; // Phase 3
