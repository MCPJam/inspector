/**
 * Browser-safe entrypoint for @mcpjam/sdk.
 *
 * This export surface intentionally excludes node-oriented eval/test utilities.
 */

export { MCPClientManager } from "./mcp-client-manager/index.js";

export type {
  MCPClientManagerConfig,
  MCPClientManagerOptions,
  MCPServerConfig,
  StdioServerConfig,
  HttpServerConfig,
  BaseServerConfig,
  MCPConnectionStatus,
  ServerSummary,
  MCPServerSummary,
  ElicitationHandler,
  ElicitationCallback,
  ElicitationCallbackRequest,
  ElicitResult,
  ProgressHandler,
  ProgressEvent,
  RpcLogger,
  RpcLogEvent,
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
  MCPPromptListResult,
  MCPPrompt,
  MCPGetPromptResult,
  MCPResourceListResult,
  MCPResource,
  MCPReadResourceResult,
  MCPResourceTemplateListResult,
  MCPResourceTemplate,
} from "./mcp-client-manager/index.js";

export {
  isChatGPTAppTool,
  isMcpAppTool,
  scrubMetaFromToolResult,
  scrubMetaAndStructuredContentFromToolResult,
  MCPError,
  MCPAuthError,
  isAuthError,
  isMCPAuthError,
} from "./mcp-client-manager/index.js";
