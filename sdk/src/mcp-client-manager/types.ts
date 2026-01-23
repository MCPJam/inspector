/**
 * TypeScript types and interfaces for MCPClientManager
 */

import type { ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import type { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ElicitRequest,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";

// Re-export ElicitResult for convenience
export type { ElicitResult };

/**
 * Client capability options extracted from MCP SDK ClientOptions
 */
export type ClientCapabilityOptions = NonNullable<
  ClientOptions["capabilities"]
>;

// ============================================================================
// Server Configuration Types
// ============================================================================

/**
 * Base configuration shared by all server types
 */
export type BaseServerConfig = {
  /** Client capabilities to advertise to this server */
  capabilities?: ClientCapabilityOptions;
  /** Request timeout in milliseconds */
  timeout?: number;
  /** Client version to report */
  version?: string;
  /** Error handler for this server */
  onError?: (error: unknown) => void;
  /** Enable simple console logging of JSON-RPC traffic */
  logJsonRpc?: boolean;
  /** Custom logger for JSON-RPC traffic (overrides logJsonRpc) */
  rpcLogger?: RpcLogger;
};

/**
 * Configuration for stdio-based MCP servers (subprocess)
 */
export type StdioServerConfig = BaseServerConfig & {
  /** Command to execute */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;

  // Discriminator fields - these should never be set for stdio
  url?: never;
  accessToken?: never;
  requestInit?: never;
  eventSourceInit?: never;
  authProvider?: never;
  reconnectionOptions?: never;
  sessionId?: never;
  preferSSE?: never;
};

/**
 * Configuration for HTTP-based MCP servers (SSE or Streamable HTTP)
 */
export type HttpServerConfig = BaseServerConfig & {
  /** Server URL */
  url: string;
  /**
   * Access token for Bearer authentication.
   * If provided, adds `Authorization: Bearer <accessToken>` header to requests.
   */
  accessToken?: string;
  /** Additional request initialization options */
  requestInit?: StreamableHTTPClientTransportOptions["requestInit"];
  /** SSE-specific event source options */
  eventSourceInit?: SSEClientTransportOptions["eventSourceInit"];
  /** OAuth auth provider */
  authProvider?: StreamableHTTPClientTransportOptions["authProvider"];
  /** Reconnection options for Streamable HTTP */
  reconnectionOptions?: StreamableHTTPClientTransportOptions["reconnectionOptions"];
  /** Session ID for Streamable HTTP */
  sessionId?: StreamableHTTPClientTransportOptions["sessionId"];
  /** Prefer SSE transport over Streamable HTTP */
  preferSSE?: boolean;

  // Discriminator fields - these should never be set for HTTP
  command?: never;
  args?: never;
  env?: never;
};

/**
 * Union type for all server configurations
 */
export type MCPServerConfig = StdioServerConfig | HttpServerConfig;

/**
 * Configuration map for multiple servers (serverId -> config)
 */
export type MCPClientManagerConfig = Record<string, MCPServerConfig>;

// ============================================================================
// Connection State Types
// ============================================================================

/**
 * Connection status for a server
 */
export type MCPConnectionStatus = "connected" | "connecting" | "disconnected";

/**
 * Summary information for a server
 */
export type ServerSummary = {
  id: string;
  status: MCPConnectionStatus;
  config?: MCPServerConfig;
};

/**
 * Internal state for a managed client connection
 */
export interface ManagedClientState {
  config: MCPServerConfig;
  timeout: number;
  client?: Client;
  transport?: Transport;
  promise?: Promise<Client>;
}

// ============================================================================
// Logging Types
// ============================================================================

/**
 * Event passed to RPC loggers
 */
export type RpcLogEvent = {
  direction: "send" | "receive";
  message: unknown;
  serverId: string;
};

/**
 * Function type for JSON-RPC logging
 */
export type RpcLogger = (event: RpcLogEvent) => void;

// ============================================================================
// Progress Types
// ============================================================================

/**
 * Progress event from server operations
 */
export type ProgressEvent = {
  serverId: string;
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
};

/**
 * Function type for progress handling
 */
export type ProgressHandler = (event: ProgressEvent) => void;

// ============================================================================
// Constructor Options
// ============================================================================

/**
 * Options for MCPClientManager constructor
 */
export interface MCPClientManagerOptions {
  /** Default client name to report to servers */
  defaultClientName?: string;
  /** Default client version to report */
  defaultClientVersion?: string;
  /** Default capabilities to advertise */
  defaultCapabilities?: ClientCapabilityOptions;
  /** Default request timeout in milliseconds */
  defaultTimeout?: number;
  /** Enable JSON-RPC logging for all servers by default */
  defaultLogJsonRpc?: boolean;
  /** Global JSON-RPC logger */
  rpcLogger?: RpcLogger;
  /** Global progress handler */
  progressHandler?: ProgressHandler;
}

// ============================================================================
// Tool Execution Types
// ============================================================================

/**
 * Arguments passed to tool execution
 */
export type ExecuteToolArguments = Record<string, unknown>;

/**
 * Options for task-augmented tool calls
 */
export type TaskOptions = {
  /** Time-to-live for the task in milliseconds */
  ttl?: number;
};

// ============================================================================
// Elicitation Types
// ============================================================================

/**
 * Handler for server-specific elicitation requests
 */
export type ElicitationHandler = (
  params: ElicitRequest["params"]
) => Promise<ElicitResult> | ElicitResult;

/**
 * Request passed to global elicitation callback
 */
export type ElicitationCallbackRequest = {
  requestId: string;
  message: string;
  schema: unknown;
  /** Task ID if this elicitation is related to a task (MCP Tasks spec 2025-11-25) */
  relatedTaskId?: string;
};

/**
 * Global callback for handling elicitation requests
 */
export type ElicitationCallback = (
  request: ElicitationCallbackRequest
) => Promise<ElicitResult> | ElicitResult;

// ============================================================================
// MCP Tasks Types (Experimental - spec 2025-11-25)
// ============================================================================

/**
 * Task status values
 */
export type MCPTaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * MCP Task object
 */
export type MCPTask = {
  taskId: string;
  status: MCPTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number | null;
  pollInterval?: number;
};

/**
 * Result from listing tasks
 */
export type MCPListTasksResult = {
  tasks: MCPTask[];
  nextCursor?: string;
};

// ============================================================================
// Client Method Parameter Types
// ============================================================================

export type ClientRequestOptions = RequestOptions;
export type CallToolOptions = RequestOptions;
export type ListResourcesParams = Parameters<Client["listResources"]>[0];
export type ListResourceTemplatesParams = Parameters<
  Client["listResourceTemplates"]
>[0];
export type ReadResourceParams = Parameters<Client["readResource"]>[0];
export type SubscribeResourceParams = Parameters<
  Client["subscribeResource"]
>[0];
export type UnsubscribeResourceParams = Parameters<
  Client["unsubscribeResource"]
>[0];
export type ListPromptsParams = Parameters<Client["listPrompts"]>[0];
export type GetPromptParams = Parameters<Client["getPrompt"]>[0];
export type ListToolsResult = Awaited<ReturnType<Client["listTools"]>>;

// ============================================================================
// Result Type Aliases for Exports
// ============================================================================

export type MCPPromptListResult = Awaited<ReturnType<Client["listPrompts"]>>;
export type MCPPrompt = MCPPromptListResult["prompts"][number];
export type MCPGetPromptResult = Awaited<ReturnType<Client["getPrompt"]>>;
export type MCPResourceListResult = Awaited<
  ReturnType<Client["listResources"]>
>;
export type MCPResource = MCPResourceListResult["resources"][number];
export type MCPReadResourceResult = Awaited<ReturnType<Client["readResource"]>>;
export type MCPResourceTemplateListResult = Awaited<
  ReturnType<Client["listResourceTemplates"]>
>;
export type MCPResourceTemplate =
  MCPResourceTemplateListResult["resourceTemplates"][number];
export type MCPServerSummary = ServerSummary;
