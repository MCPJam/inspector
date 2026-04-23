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
  RegisteredServerState,
  LiveClientState,
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
  ExecuteToolRequest,
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
export {
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
  getDefaultClientCapabilities,
  normalizeClientCapabilities,
  mergeClientCapabilities,
} from "./mcp-client-manager/index.js";

// Error classes
export {
  MCPError,
  MCPAuthError,
  isAuthError,
  isMCPAuthError,
} from "./mcp-client-manager/index.js";
export type { RetryPolicy } from "./retry.js";
export {
  DEFAULT_RETRY_POLICY,
  isRetryableTransientError,
  normalizeRetryPolicy,
  retryWithPolicy,
} from "./retry.js";
export { EvalReportingError, SdkError } from "./errors.js";
export { probeMcpServer } from "./server-probe.js";
export type {
  ProbeHttpAttempt,
  ProbeInitializeInfo,
  ProbeMcpServerConfig,
  ProbeMcpServerResult,
  ProbeOAuthDetails,
  ProbeTransportResult,
} from "./server-probe.js";
export {
  runServerDoctor,
  collectConnectedServerDoctorState,
  normalizeServerDoctorError,
} from "./server-doctor.js";
export type {
  ServerDoctorError,
  ServerDoctorCheck,
  ServerDoctorChecks,
  ServerDoctorConnection,
  ServerDoctorResult,
  ConnectedServerDoctorState,
  RunServerDoctorInput,
  ServerDoctorDependencies,
} from "./server-doctor.js";
export {
  collectServerSnapshot,
  collectConnectedServerSnapshot,
  normalizeServerSnapshot,
  serializeServerSnapshot,
  serializeStableServerSnapshot,
  ServerSnapshotFormatError,
} from "./server-snapshot.js";
export type {
  CollectServerSnapshotInput,
  CollectedServerSnapshot,
  RawServerSnapshot,
  StableServerSnapshot,
  NormalizedServerSnapshot,
  ServerSnapshotTool,
  ServerSnapshotResource,
  ServerSnapshotResourceTemplate,
  ServerSnapshotPrompt,
  ServerSnapshotDependencies,
} from "./server-snapshot.js";
export {
  diffServerSnapshots,
  collectAndDiffServerSnapshot,
  buildServerDiffReport,
} from "./server-diff.js";
export type {
  SnapshotDiffClassification,
  SnapshotDiffEntityType,
  SnapshotDiffChangeType,
  SnapshotDiffFailOn,
  SnapshotFieldChange,
  SnapshotEntityChange,
  SnapshotEntityClassificationSummary,
  SnapshotDiffSummary,
  SnapshotSurfaceSummary,
  ServerSnapshotDiffResult,
  DiffServerSnapshotsOptions,
  CollectAndDiffServerSnapshotInput,
} from "./server-diff.js";
export {
  validateToolCallEnvelope,
  evaluateToolCallOutcome,
  validateToolCallResult,
  buildToolCallValidationReport,
} from "./response-validation.js";
export type {
  ToolCallEnvelopeValidationDetails,
  ToolCallEnvelopeValidationResult,
  ToolCallOutcomePolicy,
  ToolCallOutcomeEvaluationResult,
  ToolCallValidationResult,
} from "./response-validation.js";
export { redactSensitiveValue } from "./redaction.js";
export {
  summarizeStructuredCases,
  renderStructuredRunJson,
  renderStructuredRunJUnitXml,
} from "./structured-reporting.js";
export type {
  StructuredCaseClassification,
  StructuredCaseResult,
  StructuredSummaryBucket,
  StructuredRunSummary,
  StructuredRunReport,
} from "./structured-reporting.js";
export { runOAuthLogin } from "./oauth-login.js";
export type {
  OAuthLoginConfig,
  OAuthLoginDependencies,
  OAuthLoginResult,
} from "./oauth-login.js";
export { runOAuthStateMachine } from "./oauth/state-machines/runner.js";
export type {
  OAuthAuthorizationRequestResult,
  OAuthStateMachineRunConfig,
  OAuthStateMachineRunResult,
} from "./oauth/state-machines/runner.js";
export {
  createOAuthTraceProjectionContext,
  projectOAuthTraceSnapshot,
} from "./oauth/state-machines/trace.js";
export type {
  OAuthTraceProjectionContext,
  OAuthTraceSnapshot,
  OAuthTraceStepSnapshot,
  OAuthTraceStepStatus,
} from "./oauth/state-machines/trace.js";

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
  EvalTraceSpanCategory,
  EvalTraceSpanInput,
  EvalWidgetCsp,
  EvalWidgetPermissions,
  EvalWidgetSnapshotInput,
  EvalResultInput,
  MCPServerReplayConfig,
  MCPJamReportingConfig,
  ReportEvalResultsInput,
  ReportEvalResultsOutput,
} from "./eval-reporting-types.js";

export {
  finalizePassedForEval,
  isCallToolResultError,
  traceIndicatesToolExecutionFailure,
  traceMessagePartIndicatesToolFailure,
} from "./eval-tool-execution.js";
export type { FinalizeEvalPassedParams } from "./eval-tool-execution.js";

// Eval result mapping utilities
export type {
  PromptsToEvalResultOverrides,
  RunToEvalResultsOptions,
  SuiteRunToEvalResultsOptions,
} from "./eval-result-mapping.js";
export { promptsToEvalResult } from "./eval-result-mapping.js";

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
export {
  serializeForInlineScript,
  injectOpenAICompat,
  extractBaseUrl,
  generateUrlPolyfillScript,
  WIDGET_BASE_CSS,
  buildRuntimeConfigScript,
  injectScripts,
  buildCspHeader,
  buildCspMetaContent,
  buildChatGptRuntimeHead,
} from "./widget-helpers.js";
export type { CspMode, WidgetCspMeta, CspConfig } from "./widget-helpers.js";

// OAuth proxy helpers (shared by inspector server routes and the CLI)
export {
  OAuthProxyError,
  validateUrl,
  executeOAuthProxy,
  executeDebugOAuthProxy,
  fetchOAuthMetadata,
} from "./oauth-proxy.js";
export type { OAuthProxyRequest, OAuthProxyResponse } from "./oauth-proxy.js";

// Skill reference (SKILL.md content for agent brief generation)
export { EXPLORE_TO_SDK_EVALS_SKILL_MD, SKILL_MD } from "./skill-reference.js";

// OAuth conformance
export {
  OAuthConformanceTest,
  OAuthConformanceSuite,
  formatOAuthConformanceHuman,
  formatOAuthConformanceSuiteHuman,
  createRemoteBrowserAuthorizationController,
  normalizeCustomHeaders,
  oauthConformanceProfileSchema,
} from "./oauth-conformance/index.js";
export type {
  ConformanceResult as OAuthConformanceResult,
  ConformanceStepId as OAuthConformanceStepId,
  OAuthConformanceCheckId,
  OAuthConformanceProfile,
  RemoteBrowserAuthorizationCode,
  RemoteBrowserAuthorizationController,
  RemoteBrowserAuthorizationControllerOptions,
  RemoteBrowserAuthorizationInput,
  StepResult as OAuthConformanceStepResult,
  VerificationResult as OAuthVerificationResult,
} from "./oauth-conformance/index.js";

// MCP conformance
export {
  MCPConformanceTest,
  MCPConformanceSuite,
} from "./mcp-conformance/index.js";
export type {
  MCPCheckCategory,
  MCPCheckId,
  MCPCheckResult,
  MCPCheckStatus,
  MCPConformanceConfig,
  MCPConformanceResult,
  MCPConformanceSuiteConfig,
  MCPConformanceSuiteResult,
} from "./mcp-conformance/index.js";
export {
  MCP_CHECK_CATEGORIES,
  MCP_CHECK_IDS,
  canRunConformance,
  isHttpServerConfig,
} from "./mcp-conformance/index.js";
export type {
  ConformanceSuiteId,
  ConformanceSupport,
} from "./mcp-conformance/index.js";

// MCP Apps conformance
export { MCPAppsConformanceTest } from "./apps-conformance/index.js";
export type {
  MCPAppsCheckCategory,
  MCPAppsCheckId,
  MCPAppsCheckResult,
  MCPAppsCheckStatus,
  MCPAppsConformanceConfig,
  MCPAppsConformanceResult,
  MCPAppsResourceReadOutcome,
} from "./apps-conformance/index.js";
export {
  MCP_APPS_CHECK_CATEGORIES,
  MCP_APPS_CHECK_IDS,
} from "./apps-conformance/index.js";

export type {
  ConformanceResult,
  ConformanceStepId,
  OAuthConformanceAuthConfig,
  OAuthConformanceClientConfig,
  OAuthConformanceConfig,
  OAuthConformanceSuiteConfig,
  OAuthConformanceSuiteDefaults,
  OAuthConformanceSuiteFlow,
  OAuthConformanceSuiteResult,
  OAuthVerificationConfig,
  StepResult,
  VerificationResult,
} from "./oauth-conformance/index.js";
export { CONFORMANCE_CHECK_METADATA } from "./oauth-conformance/index.js";

// MCP Operations (pure functions for common MCP workflows)
export {
  listResources,
  readResource,
  listPrompts,
  listPromptsMulti,
  getPrompt,
  listTools,
  withEphemeralClient,
  withDisposableManager,
} from "./operations.js";

export type {
  ListResourcesParams,
  ReadResourceParams,
  ListPromptsParams,
  ListPromptsMultiParams,
  GetPromptParams,
  ListToolsParams,
  WithEphemeralClientOptions,
} from "./operations.js";
