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
} from "./types.js";

// Types - State and status
export type {
  MCPConnectionStatus,
  ServerSummary,
  ManagedClientState,
} from "./types.js";

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
export type { ExecuteToolArguments, TaskOptions } from "./types.js";

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
  type ToolSchemaOverrides,
  type ConvertedToolSet,
  type CallToolExecutor,
} from "./tool-converters.js";

// Utility functions (useful for testing and advanced use cases)
export { buildRequestInit } from "./transport-utils.js";
export { isMethodUnavailableError, formatError } from "./error-utils.js";

// Error classes
export {
  MCPError,
  MCPAuthError,
  isAuthError,
  isMCPAuthError,
} from "./errors.js";

// Task utilities
export {
  supportsTasksForToolCalls,
  supportsTasksList,
  supportsTasksCancel,
} from "./tasks.js";

// Notification schemas (for advanced use cases)
export {
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
} from "./notification-handlers.js";
