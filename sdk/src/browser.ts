/**
 * Browser-safe SDK entrypoint.
 *
 * This subpath must stay free of Node-only runtime imports.
 */

export {
  MCP_UI_EXTENSION_ID,
  MCP_UI_RESOURCE_MIME_TYPE,
  getDefaultClientCapabilities,
  normalizeClientCapabilities,
  mergeClientCapabilities,
} from "./mcp-client-manager/capabilities.js";

export type {
  BaseServerConfig,
  HttpServerConfig,
  StdioServerConfig,
  MCPServerConfig,
  MCPClientManagerConfig,
  MCPConnectionStatus,
  ServerSummary,
  ClientCapabilityOptions,
  ExecuteToolArguments,
  TaskOptions,
  ListToolsResult,
  MCPPromptListResult,
  MCPPrompt,
  MCPGetPromptResult,
  MCPResourceListResult,
  MCPResource,
  MCPReadResourceResult,
  MCPResourceTemplateListResult,
  MCPResourceTemplate,
  MCPTask,
  MCPTaskStatus,
  MCPListTasksResult,
} from "./mcp-client-manager/types.js";

export type {
  CompatibleProtocol,
  CustomProvider,
  LLMProvider,
} from "./types.js";
