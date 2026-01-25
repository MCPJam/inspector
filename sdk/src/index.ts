/**
 * @mcpjam/sdk - MCP server unit testing, end to end (e2e) testing, and server evals
 *
 * @packageDocumentation
 */

// MCPClientManager from new modular implementation
export { MCPClientManager } from "./mcp-client-manager/index.js";

// Server configuration types
export type {
  MCPClientManagerConfig,
  MCPClientManagerOptions,
  MCPServerConfig,
  StdioServerConfig,
  HttpServerConfig,
  BaseServerConfig,
} from "./mcp-client-manager/index.js";

// Connection state types
export type {
  MCPConnectionStatus,
  ServerSummary,
  MCPServerSummary,
} from "./mcp-client-manager/index.js";

// Handler and callback types
export type {
  ElicitationHandler,
  ElicitationCallback,
  ElicitationCallbackRequest,
  ElicitResult,
  ProgressHandler,
  ProgressEvent,
  RpcLogger,
  RpcLogEvent,
} from "./mcp-client-manager/index.js";

// Tool and task types
export type {
  Tool,
  ToolExecuteOptions,
  AiSdkTool,
  ExecuteToolArguments,
  TaskOptions,
  ClientCapabilityOptions,
  MCPTask,
  MCPTaskStatus,
  MCPListTasksResult,
  ListToolsResult,
} from "./mcp-client-manager/index.js";

// MCP result types
export type {
  MCPPromptListResult,
  MCPPrompt,
  MCPGetPromptResult,
  MCPResourceListResult,
  MCPResource,
  MCPReadResourceResult,
  MCPResourceTemplateListResult,
  MCPResourceTemplate,
} from "./mcp-client-manager/index.js";

// Tool converters for AI SDK integration
export {
  convertMCPToolsToVercelTools,
  ensureJsonSchemaObject,
  type ToolSchemaOverrides,
  type ConvertedToolSet,
  type CallToolExecutor,
} from "./mcp-client-manager/index.js";

// Utility functions
export {
  buildRequestInit,
  isMethodUnavailableError,
  formatError,
} from "./mcp-client-manager/index.js";

// Error classes
export {
  MCPError,
  MCPAuthError,
  isAuthError,
  isMCPAuthError,
} from "./mcp-client-manager/index.js";

// Task capability utilities
export {
  supportsTasksForToolCalls,
  supportsTasksList,
  supportsTasksCancel,
} from "./mcp-client-manager/index.js";

// Notification schemas
export {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
} from "./mcp-client-manager/index.js";

// TestAgent
export { TestAgent } from "./TestAgent.js";
export type { TestAgentConfig, PromptOptions } from "./TestAgent.js";

// PromptResult class (preferred over TestAgent's interface)
export { PromptResult } from "./PromptResult.js";

// Tool extraction utilities
export { extractToolCalls, extractToolNames } from "./tool-extraction.js";

// Validators for tool call matching
export {
  matchToolCalls,
  matchToolCallsSubset,
  matchAnyToolCall,
  matchToolCallCount,
  matchNoToolCalls,
  // Argument-based validators (Phase 2.5)
  matchToolCallWithArgs,
  matchToolCallWithPartialArgs,
  matchToolArgument,
  matchToolArgumentWith,
} from "./validators.js";

// EvalTest - Single test that can run standalone
export { EvalTest } from "./EvalTest.js";
export type {
  EvalTestConfig,
  EvalTestRunOptions,
  EvalRunResult,
  IterationResult,
} from "./EvalTest.js";

// EvalSuite - Groups multiple EvalTests
export { EvalSuite } from "./EvalSuite.js";
export type {
  EvalSuiteConfig,
  EvalSuiteResult,
  TestResult,
} from "./EvalSuite.js";

// Core SDK types
export type {
  LLMProvider,
  CompatibleProtocol,
  CustomProvider,
  LLMConfig,
  ToolCall,
  TokenUsage,
  LatencyBreakdown,
  PromptResultData,
  // AI SDK message types (re-exported for convenience)
  CoreMessage,
  CoreUserMessage,
  CoreAssistantMessage,
  CoreToolMessage,
} from "./types.js";

// Percentile utilities
export {
  calculatePercentile,
  calculateLatencyStats,
  type LatencyStats,
} from "./percentiles.js";

// Model factory utilities
export {
  parseLLMString,
  createModelFromString,
  parseModelIds,
  createCustomProvider,
  PROVIDER_PRESETS,
} from "./model-factory.js";
export type {
  BaseUrls,
  CreateModelOptions,
  ParsedLLMString,
  ProviderLanguageModel,
} from "./model-factory.js";
