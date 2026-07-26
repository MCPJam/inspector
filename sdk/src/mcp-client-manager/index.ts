/**
 * MCPClientManager module - Public API exports
 *
 * @packageDocumentation
 */

// Main class
export { MCPClientManager } from "./MCPClientManager.js";

// Types - Server configuration
export type {
  MCPServerConfig,
  MCPClientManagerConfig,
  MCPClientManagerOptions,
  StdioServerConfig,
  HttpServerConfig,
  BaseServerConfig,
  UnauthorizedRefreshHandler,
  UnauthorizedRefreshResult,
} from "./types.js";

// Types - State and status
export type {
  MCPConnectionStatus,
  ServerSummary,
  ManagedClientState,
  RegisteredServerState,
  LiveClientState,
} from "./types.js";
export type { MCPServerReplayConfig } from "../eval-reporting-types.js";

// Types - Handlers and callbacks
export type {
  ElicitationHandler,
  ElicitationCallback,
  ElicitationCallbackRequest,
  ElicitationMode,
  ElicitResult,
  ProgressHandler,
  ProgressEvent,
  RpcLogger,
  RpcLogEvent,
} from "./types.js";
export type { DeclaredElicitationCapability } from "./elicitation.js";
export { DEFAULT_ELICITATION_TIMEOUT_EXTENSION_MS } from "./constants.js";

// Types - Tool execution
export type {
  ExecuteToolArguments,
  TaskOptions,
  ExecuteToolRequest,
} from "./types.js";

// Types - Request options
export type {
  ClientRequestOptions,
  CallToolOptions,
  ClientCapabilityOptions,
} from "./types.js";

// Types - Response cache (SEP-2549) provenance
export type {
  CacheMode,
  CacheScope,
  CacheHitEvent,
  CacheEventLogger,
} from "./types.js";
export {
  ObservableResponseCache,
  type ObservableResponseCacheOptions,
} from "./observable-response-cache.js";

// Types - MCP result aliases
export type {
  MCPPromptListResult,
  MCPPrompt,
  MCPGetPromptResult,
  MCPResourceListResult,
  MCPResource,
  MCPReadResourceResult,
  MCPResourceTemplateListResult,
  MCPResourceTemplate,
  MCPServerSummary,
  MCPTask,
  MCPTaskStatus,
  MCPListTasksResult,
  ListToolsResult,
} from "./types.js";

// Types - Executable tools
export type { Tool, ToolExecuteOptions, AiSdkTool } from "./types.js";

// Tool converters
export {
  convertMCPToolsToVercelTools,
  ensureJsonSchemaObject,
  isChatGPTAppTool,
  isMcpAppTool,
  scrubMetaFromToolResult,
  scrubMetaAndStructuredContentFromToolResult,
  type ToolSchemaOverrides,
  type ConvertedToolSet,
  type CallToolExecutor,
} from "./tool-converters.js";
export {
  MCP_DIRECT_IMAGE_MAX_BYTES,
  MCP_IMAGE_MAX_MEDIA_PARTS,
  MCP_IMAGE_MAX_TOTAL_BYTES,
  MCP_LINKED_RESOURCE_MAX_READS,
  MCP_PRESERVE_RAW_RESULT_FOR_UI,
  mcpCallToolResultToModelOutput,
  mcpCallToolResultToModelOutputWithLinkedResources,
  type McpModelOutputContent,
  type McpModelOutputContentPart,
  type McpModelOutputOptions,
  type McpModelOutputWithLinkedResourcesOptions,
  type McpModelVisibleToolResultPolicy,
  type McpLinkedResourceReader,
} from "./model-output.js";

// Utility functions (useful for testing and advanced use cases)
export { buildRequestInit } from "./transport-utils.js";
export { isMethodUnavailableError, formatError } from "./error-utils.js";
export {
  applyRuntimeClientCapabilities,
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
  getDefaultClientCapabilities,
  normalizeClientCapabilities,
  mergeClientCapabilities,
} from "./capabilities.js";

// Error classes
export {
  MCPError,
  MCPAuthError,
  isAuthError,
  isUnauthorized401,
  isMCPAuthError,
} from "./errors.js";

export type { RetryPolicy } from "../retry.js";
export {
  DEFAULT_RETRY_POLICY,
  isRetryableTransientError,
  normalizeRetryPolicy,
  retryWithPolicy,
} from "../retry.js";

// Task utilities
export {
  supportsTasksForToolCalls,
  supportsTasksList,
  supportsTasksCancel,
} from "./tasks.js";

// Notification schemas (for advanced use cases)
export {
  ResourceListChangedNotificationMethod,
  ResourceUpdatedNotificationMethod,
  PromptListChangedNotificationMethod,
  LoggingMessageNotificationMethod,
} from "./notification-handlers.js";

// ManagedMcpClient: interface + adapters + factory for 2026-07-28
// stateless preview. The manager types its client state as
// `ManagedMcpClient` (PR3); SDK consumers that need the underlying
// upstream `Client` keep using `getClient()`, while new consumers can
// use `getManagedClient()` for either adapter.
export type {
  ManagedMcpClient,
  ManagedMcpClientConnectOptions,
  ManagedMcpClientNotificationHandler,
  ManagedMcpClientNotificationMethod,
  ManagedMcpClientRequestHandler,
  ManagedMcpClientRequestMethod,
} from "./managed-mcp-client.js";
export {
  NotYetSupportedInStateless,
  StatelessRequiresHttpTransport,
  PaginatedToolHeaderDiscoveryUnsupported,
} from "./managed-mcp-client.js";
export { OfficialSdkClientAdapter } from "./official-sdk-client-adapter.js";
export {
  LogLevelMetaClient,
  type LogLevelProvider,
} from "./log-level-meta-client.js";
export {
  DialectAwareJsonSchemaValidator,
  type DialectAwareJsonSchemaValidatorOptions,
} from "./dialect-aware-json-schema-validator.js";
export { CspSafeDialectAwareJsonSchemaValidator } from "./csp-safe-dialect-aware-json-schema-validator.js";
export {
  createManagedMcpClient,
  wrapLegacyClient,
  type CreateManagedMcpClientArgs,
  type McpProtocolVersion,
} from "./managed-mcp-client-factory.js";
export {
  MCP_PROTOCOL_VERSIONS,
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
} from "./mcp-protocol-version.js";

// Multi-round-trip (`input_required`) manual driver — spec §12 (new exports).
export {
  DEFAULT_MAX_MRTR_ROUNDS,
  SUPPORTED_ELICITATION_MODES,
  executeInputRequiredLeg,
  resumeInputRequiredOperation,
  runInputRequiredOperation,
  initInputRequiredState,
  makeRequestWithSchemaLegSender,
  defaultResultSchemaForMethod,
  validateInputRequests,
  validateRoundResponses,
  isMaxRoundsExceeded,
  isUnsupportedResultType,
  MrtrUndeclaredInputError,
  MrtrUnsupportedElicitationModeError,
  MrtrInputValidationError,
  isInputRequiredResult,
  withInputRequired,
} from "./mrtr-driver.js";
export type {
  MrtrMethod,
  MrtrOperationState,
  MrtrLegResult,
  MrtrLegSender,
  MrtrSupportedModes,
  MrtrInputCollector,
  MrtrValidateResponse,
  ElicitationContentValidator,
  RunInputRequiredOptions,
  InputRequiredResult,
  InputRequests,
  InputResponses,
} from "./mrtr-driver.js";
