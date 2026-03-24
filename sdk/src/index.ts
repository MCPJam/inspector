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

// Tool result scrubbing utilities (for MCP Apps)
export {
  isChatGPTAppTool,
  isMcpAppTool,
  scrubMetaFromToolResult,
  scrubMetaAndStructuredContentFromToolResult,
} from "./mcp-client-manager/index.js";

// Error classes
export {
  MCPError,
  MCPAuthError,
  isAuthError,
  isMCPAuthError,
} from "./mcp-client-manager/index.js";
export { EvalReportingError, SdkError } from "./errors.js";

// EvalAgent interface (for deterministic testing without concrete TestAgent)
export type { EvalAgent, PromptOptions } from "./EvalAgent.js";

// AI SDK stop condition helpers re-exported for TestAgent.prompt()
export { hasToolCall, stepCountIs } from "ai";
export type { StopCondition } from "ai";

// TestAgent
export { TestAgent } from "./TestAgent.js";
export type { TestAgentConfig } from "./TestAgent.js";

// PromptResult class (preferred over TestAgent's interface)
export { PromptResult } from "./PromptResult.js";

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

// Eval reporting APIs (DX-first ingestion)
export {
  reportEvalResults,
  reportEvalResultsSafely,
} from "./report-eval-results.js";
export { createEvalRunReporter } from "./eval-run-reporter.js";
export type {
  CreateEvalRunReporterInput,
  EvalRunReporter,
} from "./eval-run-reporter.js";
export { uploadEvalArtifact } from "./upload-eval-artifact.js";
export type {
  UploadEvalArtifactInput,
  EvalArtifactFormat,
} from "./upload-eval-artifact.js";
export type {
  EvalExpectedToolCall,
  EvalCiMetadata,
  EvalTraceInput,
  EvalWidgetCsp,
  EvalWidgetPermissions,
  EvalWidgetSnapshotInput,
  EvalResultInput,
  MCPJamReportingConfig,
  ReportEvalResultsInput,
  ReportEvalResultsOutput,
} from "./eval-reporting-types.js";

// Eval result mapping utilities
export type {
  RunToEvalResultsOptions,
  SuiteRunToEvalResultsOptions,
} from "./eval-result-mapping.js";

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

// Widget helpers (for injecting OpenAI compat runtime into MCP App HTML)
export { injectOpenAICompat } from "./widget-helpers.js";

// Skill reference (SKILL.md content for agent brief generation)
export { SKILL_MD } from "./skill-reference.js";
