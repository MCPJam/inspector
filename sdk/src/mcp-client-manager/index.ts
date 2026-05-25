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
  ElicitResult,
  ProgressHandler,
  ProgressEvent,
  RpcLogger,
  RpcLogEvent,
} from "./types.js";

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
} from "./notification-handlers.js";

// ManagedMcpClient: interface + adapters + factory for DRAFT-2026-v1
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
  StatelessMcpHttpPreviewClient,
  STATELESS_DRAFT_2026_V1,
  type StatelessMcpHttpPreviewClientOptions,
} from "./stateless-mcp-http-preview-client.js";
export {
  createManagedMcpClient,
  wrapLegacyClient,
  type CreateManagedMcpClientArgs,
  type McpProtocolVersion,
  type TransportKind,
} from "./managed-mcp-client-factory.js";
export {
  MCP_PROTOCOL_VERSIONS,
  isKnownProtocolVersion,
  isStatelessProtocolVersion,
} from "./mcp-protocol-version.js";
