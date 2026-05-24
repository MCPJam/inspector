/**
 * MCPClientManager - Manages multiple MCP server connections
 */

import {
  type CallToolResult,
  Client,
  type ClientOptions,
  type LoggingLevel,
  SSEClientTransport,
  type ServerCapabilities,
  StdioClientTransport,
  StreamableHTTPClientTransport,
  type Transport,
  type RequestOptions,
} from "@modelcontextprotocol/client";

import type {
  MCPClientManagerConfig,
  MCPClientManagerOptions,
  MCPServerConfig,
  StdioServerConfig,
  HttpServerConfig,
  RegisteredServerState,
  LiveClientState,
  MCPConnectionStatus,
  ServerSummary,
  ClientCapabilityOptions,
  ExecuteToolArguments,
  TaskOptions,
  ExecuteToolRequest,
  ClientRequestOptions,
  ListResourcesParams,
  ListResourceTemplatesParams,
  ReadResourceParams,
  SubscribeResourceParams,
  UnsubscribeResourceParams,
  ListPromptsParams,
  GetPromptParams,
  ListToolsResult,
  ElicitationHandler,
  ElicitationCallback,
  ElicitResult,
  ProgressHandler,
  RpcLogger,
  Tool,
  AiSdkTool,
} from "./types.js";
import type { MCPServerReplayConfig } from "../eval-reporting-types.js";

import {
  DEFAULT_CLIENT_VERSION,
  DEFAULT_TIMEOUT,
  HTTP_CONNECT_TIMEOUT,
} from "./constants.js";
import { isMethodUnavailableError, formatError } from "./error-utils.js";
import { MCPAuthError, isAuthError, isUnauthorized401 } from "./errors.js";
import {
  type RetryPolicy,
  isRetryableTransientError,
  normalizeRetryPolicy,
  retryWithPolicy,
} from "../retry.js";
import {
  buildRequestInit,
  normalizeHeaders,
  getExistingAuthorization,
  stripAuthorizationFromRequestInit,
  wrapTransportForLogging,
  createDefaultRpcLogger,
} from "./transport-utils.js";
import { RefreshTokenOAuthProvider } from "./refresh-token-auth-provider.js";
import {
  NotificationManager,
  applyProgressHandler,
  PromptListChangedNotificationMethod,
  ResourceListChangedNotificationMethod,
  ResourceUpdatedNotificationMethod,
  type NotificationMethodName,
  type NotificationHandler,
} from "./notification-handlers.js";
import { ElicitationManager } from "./elicitation.js";
import {
  TaskStatusNotificationMethod,
  listTasks as tasksListTasks,
  getTask as tasksGetTask,
  getTaskResult as tasksGetTaskResult,
  cancelTask as tasksCancelTask,
  supportsTasksForToolCalls,
  supportsTasksList,
  supportsTasksCancel,
} from "./tasks.js";
import {
  convertMCPToolsToVercelTools,
  type ToolSchemaOverrides,
} from "./tool-converters.js";
import {
  applyRuntimeClientCapabilities,
  getDefaultClientCapabilities,
  mergeClientCapabilities,
  normalizeClientCapabilities,
} from "./capabilities.js";
import {
  assertCallToolResult,
  isCreateTaskResult,
} from "./result-guards.js";
import {
  createManagedMcpClient,
  wrapLegacyClient,
} from "./managed-mcp-client-factory.js";
import {
  StatelessPreviewRequiresHttpTransport,
  type ManagedMcpClient,
  type ManagedMcpClientConnectOptions,
  type ManagedMcpClientNotificationHandler,
  type ManagedMcpClientNotificationMethod,
  type ManagedMcpClientRequestHandler,
  type ManagedMcpClientRequestMethod,
} from "./managed-mcp-client.js";

/**
 * Temporary `ManagedMcpClient` slotted into `state.client` between the
 * early "construct + apply handlers" site and the
 * `connectViaHttp(wireMode: stateless)` branch that builds the real
 * preview client. Notification + elicitation handlers registered on
 * this stub are re-applied to the real client after construction; if
 * any RPC method is called against the stub we throw loudly to surface
 * the wiring bug.
 */
function createPendingStatelessClientStub(): ManagedMcpClient {
  const handlers = {
    notifications: new Map<
      ManagedMcpClientNotificationMethod,
      ManagedMcpClientNotificationHandler
    >(),
    requests: new Map<
      ManagedMcpClientRequestMethod,
      ManagedMcpClientRequestHandler
    >(),
  };
  const fail = (method: string) => {
    throw new Error(
      `MCPClientManager: ${method}() called on pending stateless client stub. This indicates a wiring bug — the real StatelessDraft2026V1PreviewClient should have replaced the stub inside connectViaHttp before any RPC.`,
    );
  };
  return {
    async connect(_t, _o?: ManagedMcpClientConnectOptions) {
      // Accepted but no-op; the real preview client's connect() runs
      // inside connectViaHttp before any RPC fires.
    },
    async close() {},
    getServerCapabilities: () => undefined,
    getServerVersion: () => undefined,
    getInstructions: () => undefined,
    listTools: () => fail("listTools"),
    callTool: () => fail("callTool"),
    request: () => fail("request"),
    listResources: () => fail("listResources"),
    readResource: () => fail("readResource"),
    listResourceTemplates: () => fail("listResourceTemplates"),
    listPrompts: () => fail("listPrompts"),
    getPrompt: () => fail("getPrompt"),
    ping: () => fail("ping"),
    subscribeResource: () => fail("subscribeResource"),
    unsubscribeResource: () => fail("unsubscribeResource"),
    setLoggingLevel: async () => {
      // Tolerate the manager's eager setLoggingLevel("debug") fire-and-
      // forget at the end of connectClient — by the time it lands the
      // stub may still be the active client. No-op until the real
      // preview client replaces it; the post-connect guard at
      // setLoggingLevel inside this manager prevents repeat calls.
    },
    setNotificationHandler: (method, handler) => {
      handlers.notifications.set(method, handler);
    },
    setRequestHandler: (method, handler) => {
      handlers.requests.set(method, handler);
    },
    removeRequestHandler: (method) => {
      handlers.requests.delete(method);
    },
  };
}

/**
 * Manages multiple MCP server connections with support for tools, resources,
 * prompts, notifications, elicitation, and tasks.
 *
 * @example
 * ```typescript
 * const manager = new MCPClientManager({
 *   everything: {
 *     command: "npx",
 *     args: ["-y", "@modelcontextprotocol/server-everything"],
 *   },
 *   myServer: {
 *     url: "https://my-server.com/mcp",
 *     accessToken: "my-token",
 *   },
 * });
 *
 * const tools = await manager.listTools("everything");
 * const result = await manager.executeTool("everything", "add", { a: 1, b: 2 });
 * ```
 */
export class MCPClientManager {
  // State management
  private readonly registeredServers = new Map<string, RegisteredServerState>();
  private readonly liveClientStates = new Map<string, LiveClientState>();
  private readonly toolsMetadataCache = new Map<string, Map<string, any>>();
  private readonly retryAbortControllers = new Map<string, Set<AbortController>>();
  private readonly unauthorizedRefreshInFlight = new Map<
    string,
    Promise<string>
  >();

  // Managers for specific features
  private readonly notificationManager = new NotificationManager();
  private readonly elicitationManager = new ElicitationManager();

  // Default options
  private readonly defaultClientName: string | undefined;
  private readonly defaultClientVersion: string;
  /**
   * Extra `clientInfo` fields (e.g. `title`) merged into the per-connection
   * `clientInfo` object alongside name/version. Per-server `clientInfo`
   * overrides individual keys. Lets the inspector pass forward-compat MCP
   * spec additions (the `title` field, future fields) without an SDK bump.
   */
  private readonly defaultClientInfoExtras: Record<string, unknown>;
  /**
   * Default supported protocol versions accept-list. Forwarded to the
   * upstream Client as `ClientOptions.supportedProtocolVersions`. Per-
   * server `supportedProtocolVersions` overrides this. Undefined here
   * preserves historical behavior (upstream Client's built-in
   * `SUPPORTED_PROTOCOL_VERSIONS` default).
   */
  private readonly defaultSupportedProtocolVersions: string[] | undefined;
  private readonly defaultCapabilities: ClientCapabilityOptions;
  private readonly defaultTimeout: number;
  private readonly defaultLogJsonRpc: boolean;
  private readonly defaultRpcLogger?: RpcLogger;
  private readonly defaultProgressHandler?: ProgressHandler;
  private readonly defaultRetryPolicy: RetryPolicy;
  private readonly lazyConnect: boolean;

  // Progress token counter for uniqueness
  private progressTokenCounter = 0;

  /**
   * Creates a new MCPClientManager.
   *
   * @param servers - Configuration map of server IDs to server configs
   * @param options - Global options for the manager
   */
  constructor(
    servers: MCPClientManagerConfig = {},
    options: MCPClientManagerOptions = {}
  ) {
    this.defaultClientVersion =
      options.defaultClientVersion ?? DEFAULT_CLIENT_VERSION;
    this.defaultClientName = options.defaultClientName;
    this.defaultClientInfoExtras = options.defaultClientInfoExtras ?? {};
    this.defaultSupportedProtocolVersions =
      options.defaultSupportedProtocolVersions;
    this.defaultCapabilities = mergeClientCapabilities(
      getDefaultClientCapabilities(),
      options.defaultCapabilities
    );
    this.defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT;
    this.defaultLogJsonRpc = options.defaultLogJsonRpc ?? false;
    this.defaultRpcLogger = options.rpcLogger;
    this.defaultProgressHandler = options.progressHandler;
    this.defaultRetryPolicy = normalizeRetryPolicy(options.retryPolicy);
    this.lazyConnect = options.lazyConnect ?? false;

    // Start connecting to all configured servers (unless replay/trace-repair use explicit connect)
    if (!this.lazyConnect) {
      for (const [id, config] of Object.entries(servers)) {
        void this.connectToServer(id, config);
      }
    }
  }

  // ===========================================================================
  // Server Management
  // ===========================================================================

  /**
   * Lists all registered server IDs.
   */
  listServers(): string[] {
    return Array.from(this.registeredServers.keys());
  }

  /**
   * Checks if a server is registered.
   */
  hasServer(serverId: string): boolean {
    return this.registeredServers.has(serverId);
  }

  /**
   * Gets summaries for all registered servers.
   */
  getServerSummaries(): ServerSummary[] {
    return Array.from(this.registeredServers.entries()).map(
      ([serverId, state]) => ({
        id: serverId,
        status: this.getConnectionStatus(serverId),
        config: state.config,
      })
    );
  }

  /**
   * Gets replayable HTTP server configs for eval reporting.
   */
  getServerReplayConfigs(): MCPServerReplayConfig[] {
    return Array.from(this.registeredServers.entries())
      .map(([serverId, state]) =>
        this.buildServerReplayConfig(
          serverId,
          state,
          this.liveClientStates.get(serverId)
        )
      )
      .filter(
        (config): config is MCPServerReplayConfig => config !== undefined
      );
  }

  /**
   * Gets the connection status for a server.
   */
  getConnectionStatus(serverId: string): MCPConnectionStatus {
    const state = this.liveClientStates.get(serverId);
    if (state?.retryPromise || state?.connectPromise) return "connecting";
    if (state?.client) return "connected";
    return "disconnected";
  }

  /**
   * Gets the configuration for a server.
   */
  getServerConfig(serverId: string): MCPServerConfig | undefined {
    return this.registeredServers.get(serverId)?.config;
  }

  /**
   * Gets the capabilities reported by a server.
   */
  getServerCapabilities(serverId: string): ServerCapabilities | undefined {
    return this.liveClientStates.get(serverId)?.client?.getServerCapabilities();
  }

  /**
   * Gets the underlying upstream MCP `Client` for a server. Returns the
   * legacy adapter's wrapped `Client` instance, or `undefined` for
   * stateless-preview connections (which have no upstream `Client`).
   *
   * **Deprecated for new code** — prefer `getManagedClient()`. Kept
   * because external SDK consumers reference this API; retyping it
   * would be a breaking change.
   */
  getClient(serverId: string): Client | undefined {
    const managed = this.liveClientStates.get(serverId)?.client;
    if (!managed) return undefined;
    // `OfficialSdkClientAdapter` exposes the wrapped Client via `.inner`;
    // structural check keeps this independent of an instanceof tree-
    // shaken across the SDK boundary.
    const inner = (managed as { inner?: Client }).inner;
    return inner;
  }

  /**
   * Gets the `ManagedMcpClient` for a server — works for both the legacy
   * adapter and the DRAFT-2026-v1 stateless preview. Use this in new
   * code instead of `getClient()`.
   */
  getManagedClient(
    serverId: string,
  ): import("./managed-mcp-client.js").ManagedMcpClient | undefined {
    return this.liveClientStates.get(serverId)?.client;
  }

  /**
   * Gets initialization information for a connected server.
   */
  getInitializationInfo(serverId: string) {
    const configState = this.registeredServers.get(serverId);
    const liveState = this.liveClientStates.get(serverId);
    const client = liveState?.client;
    if (!client) return undefined;

    const config = configState?.config;
    if (!config) return undefined;
    let transportType: string;
    if (this.isStdioConfig(config)) {
      transportType = "stdio";
    } else {
      const url = new URL(config.url);
      transportType =
        config.preferSSE || url.pathname.endsWith("/sse")
          ? "sse"
          : "streamable-http";
    }

    let protocolVersion: string | undefined;
    if (liveState.transport) {
      protocolVersion = (liveState.transport as any)._protocolVersion;
    }

    return {
      protocolVersion,
      transport: transportType,
      serverCapabilities: client.getServerCapabilities(),
      serverVersion: client.getServerVersion(),
      instructions: client.getInstructions(),
      clientCapabilities:
        liveState.initializedClientCapabilities ??
        this.buildCapabilities(serverId, config),
    };
  }

  // ===========================================================================
  // Connection Management
  // ===========================================================================

  /**
   * Connects to an MCP server.
   *
   * @param serverId - Unique identifier for the server
   * @param config - Server configuration
   * @returns The connected MCP Client
   */
  async connectToServer(
    serverId: string,
    config: MCPServerConfig
  ): Promise<ManagedMcpClient> {
    const liveState = this.liveClientStates.get(serverId);
    if (liveState?.client) {
      throw new Error(`MCP server "${serverId}" is already connected.`);
    }
    if (liveState?.retryPromise) {
      return liveState.retryPromise;
    }

    const timeout = config.timeout ?? this.defaultTimeout;
    this.registerServer(serverId, config, timeout);
    const { signal, cleanup } = this.createRetrySignal(serverId);

    const state: LiveClientState = liveState ?? {};
    const retryPromise = Promise.resolve().then(() =>
      retryWithPolicy({
        policy: this.defaultRetryPolicy,
        signal,
        operation: () => this.connectToServerOnce(serverId, signal),
        shouldRetryError: (error) => isRetryableTransientError(error),
        onRetry: async () => {
          await this.destroyLiveState(serverId, {
            preserveRetryPromise: true,
            abortRetryOperations: false,
          });
        },
      })
    );
    state.retryPromise = retryPromise;
    this.liveClientStates.set(serverId, state);

    try {
      return await retryPromise;
    } finally {
      cleanup();
      const latestState = this.liveClientStates.get(serverId);
      if (latestState?.retryPromise === retryPromise) {
        latestState.retryPromise = undefined;
        if (!latestState.client && !latestState.connectPromise) {
          this.liveClientStates.delete(serverId);
        }
      }
    }
  }

  /**
   * Disconnects from a server.
   */
  async disconnectServer(serverId: string): Promise<void> {
    const state = this.liveClientStates.get(serverId);
    if (!state) {
      this.abortRetrySignals(serverId);
      return;
    }
    await this.destroyLiveState(serverId);
  }

  /**
   * Removes a server from the manager entirely.
   */
  async removeServer(serverId: string): Promise<void> {
    await this.disconnectServer(serverId);
    this.registeredServers.delete(serverId);
    this.toolsMetadataCache.delete(serverId);
    this.notificationManager.clearServer(serverId);
    this.elicitationManager.clearServer(serverId);
  }

  /**
   * Disconnects from all servers.
   */
  async disconnectAllServers(): Promise<void> {
    const serverIds = Array.from(
      new Set([
        ...this.liveClientStates.keys(),
        ...this.retryAbortControllers.keys(),
      ])
    );
    await Promise.all(serverIds.map((id) => this.disconnectServer(id)));
  }

  // ===========================================================================
  // Tools
  // ===========================================================================

  /**
   * Lists tools available from a server.
   */
  async listTools(
    serverId: string,
    params?: Parameters<Client["listTools"]>[0],
    options?: ClientRequestOptions
  ): Promise<ListToolsResult> {
    return this.runRetryableReadOperation(serverId, options, async (client) => {
      try {
        const result = await client.listTools(
          params,
          this.withTimeout(serverId, options)
        );
        this.cacheToolsMetadata(serverId, result.tools);
        return result;
      } catch (error) {
        if (isMethodUnavailableError(error, "tools/list")) {
          this.toolsMetadataCache.set(serverId, new Map());
          return { tools: [] } as ListToolsResult;
        }
        throw error;
      }
    });
  }

  /**
   * Gets tools from multiple servers (or all servers if none specified).
   * Returns tools with execute functions pre-wired to call this manager.
   *
   * @param serverIds - Server IDs to get tools from (or all if omitted)
   * @returns Array of executable tools
   *
   * @example
   * ```typescript
   * const tools = await manager.getTools(["asana"]);
   * const agent = new TestAgent({ tools, model: "openai/gpt-4o", apiKey });
   * ```
   */
  async getTools(serverIds?: string[]): Promise<Tool[]> {
    const targetIds = serverIds !== undefined ? serverIds : this.listServers();

    const toolLists = await Promise.all(
      targetIds.map(async (serverId) => {
        const result = await this.listTools(serverId);

        // Attach execute function to each tool
        return result.tools.map((tool) => ({
          ...tool,
          _meta: { ...tool._meta, _serverId: serverId },
          execute: async (
            args: Record<string, unknown>,
            options?: { signal?: AbortSignal }
          ): Promise<CallToolResult> => {
            // When called without taskOptions, executeTool always returns CallToolResult
            const requestOptions = options?.signal
              ? { signal: options.signal }
              : undefined;
            return this.executeTool(
              serverId,
              tool.name,
              args,
              requestOptions
            ) as Promise<CallToolResult>;
          },
        }));
      })
    );

    return toolLists.flat();
  }

  /**
   * Gets cached tool metadata for a server.
   */
  getAllToolsMetadata(serverId: string): Record<string, Record<string, any>> {
    const metadataMap = this.toolsMetadataCache.get(serverId);
    return metadataMap ? Object.fromEntries(metadataMap) : {};
  }

  /**
   * Gets cached metadata for a specific tool.
   * Metadata is populated when tools are listed via listTools()/getTools()/getToolsForAiSdk().
   */
  getToolMetadata(
    serverId: string,
    toolName: string
  ): Record<string, unknown> | undefined {
    const metadataMap = this.toolsMetadataCache.get(serverId);
    const metadata = metadataMap?.get(toolName);
    if (!metadata || typeof metadata !== "object") {
      return undefined;
    }
    return { ...(metadata as Record<string, unknown>) };
  }

  /**
   * Gets tools formatted for Vercel AI SDK.
   *
   * @param serverIds - Server IDs to get tools from (or all if omitted)
   * @param options - Schema options
   * @returns AiSdkTool compatible with Vercel AI SDK's generateText()
   */
  async getToolsForAiSdk(
    serverIds?: string[] | string,
    options: {
      schemas?: ToolSchemaOverrides | "automatic";
      needsApproval?: boolean;
    } = {}
  ): Promise<AiSdkTool> {
    const ids = Array.isArray(serverIds)
      ? serverIds
      : serverIds
        ? [serverIds]
        : this.listServers();

    const perServerTools = await Promise.all(
      ids.map(async (id) => {
        try {
          const listToolsResult = await this.listTools(id);

          const tools = await convertMCPToolsToVercelTools(listToolsResult, {
            schemas: options.schemas,
            needsApproval: options.needsApproval,
            callTool: async ({ name, args, options: callOptions }) => {
              const requestOptions = callOptions?.abortSignal
                ? { signal: callOptions.abortSignal }
                : undefined;
              const result = await this.executeTool(
                id,
                name,
                (args ?? {}) as ExecuteToolArguments,
                requestOptions
              );
              return assertCallToolResult(
                result,
                `Tool "${name}" result`
              );
            },
          });

          // Attach server ID metadata to each tool
          for (const [_name, tool] of Object.entries(tools)) {
            (tool as any)._serverId = id;
          }
          return tools;
        } catch (error) {
          if (isMethodUnavailableError(error, "tools/list")) {
            return {} as AiSdkTool;
          }
          throw error;
        }
      })
    );

    // Flatten (last-in wins for name collisions)
    const flattened: AiSdkTool = {};
    for (const toolset of perServerTools) {
      Object.assign(flattened, toolset);
    }
    return flattened;
  }

  /**
   * Executes a tool on a server.
   *
   * @param serverId - The server ID
   * @param toolName - The tool name
   * @param args - Tool arguments
   * @param options - Request options
   * @param taskOptions - Task options for async execution
   */
  async executeTool(
    serverId: string,
    toolName: string,
    args?: ExecuteToolArguments,
    options?: ClientRequestOptions,
    taskOptions?: TaskOptions
  ): Promise<CallToolResult | Record<string, unknown>>;
  async executeTool(
    serverId: string,
    toolName: string,
    args: ExecuteToolArguments | undefined,
    options: ExecuteToolRequest
  ): Promise<CallToolResult | Record<string, unknown>>;
  async executeTool(
    serverId: string,
    toolName: string,
    args: ExecuteToolArguments = {},
    options?: ClientRequestOptions | ExecuteToolRequest,
    taskOptions?: TaskOptions
  ) {
    const request = this.normalizeExecuteToolRequest(options, taskOptions);
    const operation = async (signal?: AbortSignal) => {
      await this.ensureConnected(serverId, signal);
      const client = this.getClientOrThrow(serverId);
      const mergedOptions = this.withProgressHandler(serverId, request.request);
      const callParams = { name: toolName, arguments: args };

      if (request.task !== undefined) {
        const taskValue =
          request.task.ttl !== undefined ? { ttl: request.task.ttl } : {};
        const result = await client.request(
          { method: "tools/call", params: callParams },
          { ...mergedOptions, task: taskValue }
        );
        if (!isCreateTaskResult(result)) {
          throw new TypeError(
            `Server "${serverId}" did not return a CreateTaskResult for task-augmented tools/call.`
          );
        }
        return {
          task: result.task,
          _meta: {
            "io.modelcontextprotocol/model-immediate-response": `Task ${result.task.taskId} created with status: ${result.task.status}`,
          },
        };
      }

      return client.callTool(callParams, mergedOptions);
    };

    return this.runRetriedOperation(
      serverId,
      request.request,
      request.retry ?? { retries: 0, retryDelayMs: 0 },
      operation
    );
  }

  // ===========================================================================
  // Resources
  // ===========================================================================

  /**
   * Lists resources available from a server.
   */
  async listResources(
    serverId: string,
    params?: ListResourcesParams,
    options?: ClientRequestOptions
  ) {
    return this.runRetryableReadOperation(serverId, options, async (client) => {
      try {
        return await client.listResources(
          params,
          this.withTimeout(serverId, options)
        );
      } catch (error) {
        if (isMethodUnavailableError(error, "resources/list")) {
          return { resources: [] } as Awaited<
            ReturnType<Client["listResources"]>
          >;
        }
        throw error;
      }
    });
  }

  /**
   * Reads a resource from a server.
   */
  async readResource(
    serverId: string,
    params: ReadResourceParams,
    options?: ClientRequestOptions
  ) {
    return this.runRetryableReadOperation(serverId, options, (client) =>
      client.readResource(params, this.withProgressHandler(serverId, options))
    );
  }

  /**
   * Subscribes to resource updates.
   */
  async subscribeResource(
    serverId: string,
    params: SubscribeResourceParams,
    options?: ClientRequestOptions
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);
    return client.subscribeResource(
      params,
      this.withTimeout(serverId, options)
    );
  }

  /**
   * Unsubscribes from resource updates.
   */
  async unsubscribeResource(
    serverId: string,
    params: UnsubscribeResourceParams,
    options?: ClientRequestOptions
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);
    return client.unsubscribeResource(
      params,
      this.withTimeout(serverId, options)
    );
  }

  /**
   * Lists resource templates from a server.
   */
  async listResourceTemplates(
    serverId: string,
    params?: ListResourceTemplatesParams,
    options?: ClientRequestOptions
  ) {
    return this.runRetryableReadOperation(serverId, options, (client) =>
      client.listResourceTemplates(params, this.withTimeout(serverId, options))
    );
  }

  // ===========================================================================
  // Prompts
  // ===========================================================================

  /**
   * Lists prompts available from a server.
   */
  async listPrompts(
    serverId: string,
    params?: ListPromptsParams,
    options?: ClientRequestOptions
  ) {
    return this.runRetryableReadOperation(serverId, options, async (client) => {
      const capabilities = client.getServerCapabilities();
      if (capabilities && !capabilities.prompts) {
        return { prompts: [] } as Awaited<ReturnType<Client["listPrompts"]>>;
      }

      try {
        return await client.listPrompts(
          params,
          this.withTimeout(serverId, options)
        );
      } catch (error) {
        if (isMethodUnavailableError(error, "prompts/list")) {
          return { prompts: [] } as Awaited<ReturnType<Client["listPrompts"]>>;
        }
        throw error;
      }
    });
  }

  /**
   * Gets a prompt from a server.
   */
  async getPrompt(
    serverId: string,
    params: GetPromptParams,
    options?: ClientRequestOptions
  ) {
    return this.runRetryableReadOperation(serverId, options, (client) =>
      client.getPrompt(params, this.withProgressHandler(serverId, options))
    );
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Pings a server to check connectivity.
   */
  async pingServer(
    serverId: string,
    options?: RequestOptions
  ): Promise<Awaited<ReturnType<Client["ping"]>>> {
    return this.runRetryableReadOperation(serverId, options, async (client) =>
      client.ping(options)
    );
  }

  /**
   * Sets the logging level for a server.
   */
  async setLoggingLevel(
    serverId: string,
    level: LoggingLevel = "debug"
  ): Promise<void> {
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);
    await client.setLoggingLevel(level);
  }

  /**
   * Gets the session ID for a Streamable HTTP server.
   */
  getSessionIdByServer(serverId: string): string | undefined {
    const state = this.liveClientStates.get(serverId);
    if (!state?.transport) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }
    if (state.transport instanceof StreamableHTTPClientTransport) {
      return state.transport.sessionId;
    }
    throw new Error(
      `Server "${serverId}" must be Streamable HTTP to get the session ID.`
    );
  }

  // ===========================================================================
  // Notification Handlers
  // ===========================================================================

  /**
   * Adds a notification handler for a server.
   */
  addNotificationHandler(
    serverId: string,
    method: NotificationMethodName,
    handler: NotificationHandler
  ): void {
    this.notificationManager.addHandler(serverId, method, handler);

    const client = this.liveClientStates.get(serverId)?.client;
    if (client) {
      client.setNotificationHandler(
        method,
        this.notificationManager.createDispatcher(serverId, method)
      );
    }
  }

  /**
   * Registers a handler for resource list changes.
   */
  onResourceListChanged(serverId: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverId,
      ResourceListChangedNotificationMethod,
      handler
    );
  }

  /**
   * Registers a handler for resource updates.
   */
  onResourceUpdated(serverId: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverId,
      ResourceUpdatedNotificationMethod,
      handler
    );
  }

  /**
   * Registers a handler for prompt list changes.
   */
  onPromptListChanged(serverId: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverId,
      PromptListChangedNotificationMethod,
      handler
    );
  }

  /**
   * Registers a handler for task status changes.
   */
  onTaskStatusChanged(serverId: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverId,
      TaskStatusNotificationMethod,
      handler
    );
  }

  // ===========================================================================
  // Elicitation
  // ===========================================================================

  /**
   * Sets a server-specific elicitation handler.
   */
  setElicitationHandler(serverId: string, handler: ElicitationHandler): void {
    if (!this.registeredServers.has(serverId)) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }
    this.elicitationManager.setHandler(serverId, handler);

    const state = this.liveClientStates.get(serverId);
    const client = state?.client;
    if (client && this.hasNegotiatedElicitation(state)) {
      this.elicitationManager.applyToClient(serverId, client);
    }
  }

  /**
   * Clears a server-specific elicitation handler.
   */
  clearElicitationHandler(serverId: string): void {
    this.elicitationManager.clearHandler(serverId);
    const state = this.liveClientStates.get(serverId);
    const client = state?.client;
    if (client) {
      if (
        this.elicitationManager.getGlobalCallback() &&
        this.hasNegotiatedElicitation(state)
      ) {
        this.elicitationManager.applyToClient(serverId, client);
      } else {
        this.elicitationManager.removeFromClient(client);
      }
    }
  }

  /**
   * Sets a global elicitation callback for all servers.
   */
  setElicitationCallback(callback: ElicitationCallback): void {
    this.elicitationManager.setGlobalCallback(callback);
    for (const [serverId, state] of this.liveClientStates.entries()) {
      if (state.client && this.hasNegotiatedElicitation(state)) {
        this.elicitationManager.applyToClient(serverId, state.client);
      }
    }
  }

  /**
   * Clears the global elicitation callback.
   */
  clearElicitationCallback(): void {
    this.elicitationManager.clearGlobalCallback();
    for (const [serverId, state] of this.liveClientStates.entries()) {
      if (!state.client) continue;
      if (
        this.elicitationManager.getHandler(serverId) &&
        this.hasNegotiatedElicitation(state)
      ) {
        this.elicitationManager.applyToClient(serverId, state.client);
      } else {
        this.elicitationManager.removeFromClient(state.client);
      }
    }
  }

  /**
   * Gets the pending elicitations map for external resolvers.
   */
  getPendingElicitations() {
    return this.elicitationManager.getPendingElicitations();
  }

  /**
   * Responds to a pending elicitation.
   */
  respondToElicitation(requestId: string, response: ElicitResult): boolean {
    return this.elicitationManager.respond(requestId, response);
  }

  // ===========================================================================
  // Tasks (MCP Tasks experimental feature)
  // ===========================================================================

  /**
   * Lists tasks from a server.
   */
  async listTasks(
    serverId: string,
    cursor?: string,
    options?: ClientRequestOptions
  ) {
    return this.runRetryableReadOperation(serverId, options, async (client) => {
      try {
        return await tasksListTasks(
          client,
          cursor,
          this.withTimeout(serverId, options)
        );
      } catch (error) {
        if (isMethodUnavailableError(error, "tasks/list")) {
          return { tasks: [] };
        }
        throw error;
      }
    });
  }

  /**
   * Gets a task by ID.
   */
  async getTask(
    serverId: string,
    taskId: string,
    options?: ClientRequestOptions
  ) {
    return this.runRetryableReadOperation(serverId, options, (client) =>
      tasksGetTask(client, taskId, this.withTimeout(serverId, options))
    );
  }

  /**
   * Gets the result of a completed task.
   */
  async getTaskResult(
    serverId: string,
    taskId: string,
    options?: ClientRequestOptions
  ) {
    return this.runRetryableReadOperation(serverId, options, (client) =>
      tasksGetTaskResult(client, taskId, this.withTimeout(serverId, options))
    );
  }

  /**
   * Cancels a task.
   */
  async cancelTask(
    serverId: string,
    taskId: string,
    options?: ClientRequestOptions
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);
    return tasksCancelTask(client, taskId, this.withTimeout(serverId, options));
  }

  /**
   * Checks if server supports task-augmented tool calls.
   */
  supportsTasksForToolCalls(serverId: string): boolean {
    return supportsTasksForToolCalls(this.getServerCapabilities(serverId));
  }

  /**
   * Checks if server supports listing tasks.
   */
  supportsTasksList(serverId: string): boolean {
    return supportsTasksList(this.getServerCapabilities(serverId));
  }

  /**
   * Checks if server supports canceling tasks.
   */
  supportsTasksCancel(serverId: string): boolean {
    return supportsTasksCancel(this.getServerCapabilities(serverId));
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  private registerServer(
    serverId: string,
    config: MCPServerConfig,
    timeout: number
  ): RegisteredServerState {
    const state: RegisteredServerState = {
      config,
      timeout,
    };
    this.registeredServers.set(serverId, state);
    return state;
  }

  private async connectToServerOnce(
    serverId: string,
    signal?: AbortSignal
  ): Promise<ManagedMcpClient> {
    this.throwIfAborted(signal);

    const registeredState = this.registeredServers.get(serverId);
    if (!registeredState) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }

    const existingState = this.liveClientStates.get(serverId);
    if (existingState?.client) {
      throw new Error(`MCP server "${serverId}" is already connected.`);
    }

    if (existingState?.connectPromise) {
      return this.awaitWithAbort(existingState.connectPromise, signal);
    }

    const state: LiveClientState = existingState ?? {};
    state.authProvider = undefined;

    const connectionPromise = Promise.resolve().then(() =>
      this.performConnection(
        serverId,
        registeredState.config,
        registeredState.timeout,
        state
      )
    );
    state.connectPromise = connectionPromise;
    this.liveClientStates.set(serverId, state);
    return this.awaitWithAbort(connectionPromise, signal);
  }

  private async performConnection(
    serverId: string,
    config: MCPServerConfig,
    timeout: number,
    state: LiveClientState
  ): Promise<ManagedMcpClient> {
    let client: ManagedMcpClient | undefined;
    let transport: Transport | undefined;
    const clientCapabilities = this.buildCapabilities(serverId, config);
    try {
      // Resolve clientInfo from (in order): per-server `clientInfo` >
      // per-server `version` (legacy) > manager defaults. Extras (e.g.
      // `title` and future spec fields) merge through verbatim so the
      // inspector can advertise them without an SDK bump.
      const resolvedClientInfo: Record<string, unknown> = {
        ...this.defaultClientInfoExtras,
        ...(config.clientInfo ?? {}),
        name:
          config.clientInfo?.name ??
          this.defaultClientName ??
          serverId,
        version:
          config.clientInfo?.version ??
          config.version ??
          this.defaultClientVersion,
      };
      // Resolve the supported protocol versions accept-list. Per-server
      // `supportedProtocolVersions` wins over
      // `defaultSupportedProtocolVersions`; when neither is set we omit the
      // option so the upstream Client uses its built-in
      // `SUPPORTED_PROTOCOL_VERSIONS` default (preserves historical wire
      // behavior byte-for-byte). The MCP SDK's Client accepts
      // `supportedProtocolVersions: string[]` in ClientOptions —
      // `supportedProtocolVersions[0]` is sent in
      // `initialize.params.protocolVersion`; the full set is the accept-
      // list used to validate the server's response. Forwarding the full
      // array (rather than collapsing to a single entry) lets users pin a
      // multi-version accept-list — e.g. `["2025-11-25", "2025-06-18"]`
      // proposes the newer version but still accepts the older one.
      const supportedProtocolVersions =
        config.supportedProtocolVersions ??
        this.defaultSupportedProtocolVersions;
      const clientOptions: ClientOptions = {
        capabilities: clientCapabilities,
        ...(supportedProtocolVersions && supportedProtocolVersions.length > 0
          ? { supportedProtocolVersions }
          : {}),
      };
      // Resolve the outbound wire mode. Per
      // `peppy-popping-flask.md` §"Effective mode resolution" the
      // upstream caller (inspector backend) has already done host-
      // default + per-server override resolution and stamped the
      // effective value on the config. We accept that value here
      // without re-resolving.
      const httpWireMode =
        !this.isStdioConfig(config) && config.mcpWireMode
          ? config.mcpWireMode
          : "legacy";

      // Legacy path: construct upstream `Client` early at this site so
      // the existing notification/elicitation/error wiring keeps
      // working. Wrap in the adapter immediately so `state.client` is
      // always `ManagedMcpClient`. Stateless preview defers
      // construction until HTTP auth is resolved (see
      // `connectViaHttp`), so the upstream Client is never created on
      // that path.
      let managedClient: ManagedMcpClient;
      let upstreamClient: Client | undefined;
      if (httpWireMode === "legacy") {
        upstreamClient = new Client(
          resolvedClientInfo as { name: string; version: string },
          clientOptions
        );
        managedClient = wrapLegacyClient(upstreamClient);
      } else {
        // Stateless preview gate: must be HTTP. The connectViaHttp path
        // builds + assigns the preview client when this branch is taken.
        if (this.isStdioConfig(config)) {
          throw new StatelessPreviewRequiresHttpTransport("stdio");
        }
        // Temporary placeholder — overwritten inside `connectViaHttp`
        // once we have the resolved URL / headers / auth. Keep
        // `managedClient` unassigned until then by using a tagged stub
        // that fails loudly if any caller tries to use it before
        // construction.
        managedClient = createPendingStatelessClientStub();
      }
      client = managedClient;

      // Apply handlers (no-ops for the stateless stub; rewired after
      // the real client is constructed inside connectViaHttp).
      this.notificationManager.applyToClient(serverId, client);
      if (this.defaultProgressHandler) {
        applyProgressHandler(serverId, client, this.defaultProgressHandler);
      }
      if ((clientCapabilities as Record<string, unknown>).elicitation != null) {
        this.elicitationManager.applyToClient(serverId, client);
      }

      if (config.onError) {
        client.onerror = (error) => config.onError?.(error);
      }

      client.onclose = () => {
        if (this.liveClientStates.get(serverId) === state) {
          this.clearClosedPendingConnectionState(serverId, state);
        }
      };

      if (this.isStdioConfig(config)) {
        transport = await this.connectViaStdio(
          serverId,
          client,
          config,
          timeout,
          state
        );
      } else {
        transport = await this.connectViaHttp(
          serverId,
          client,
          config,
          timeout,
          state,
          {
            wireMode: httpWireMode,
            // Pass the resolved clientInfo so the stateless preview can
            // emit it in `_meta.io.modelcontextprotocol/clientInfo`
            // without re-resolving from manager defaults.
            clientInfo: resolvedClientInfo as {
              name: string;
              version: string;
            },
            // When the wire mode is stateless, the caller below
            // replaces `client` and the upstream Client (if any) is
            // discarded. Pass the slot so `connectViaHttp` can reassign.
            assignClient: (next: ManagedMcpClient) => {
              client = next;
              state.client = next;
            },
          }
        );
      }

      if (this.liveClientStates.get(serverId) !== state) {
        await client.close().catch(() => undefined);
        // Transport is undefined for the stateless preview path (the
        // preview owns its own fetch; no separate Transport instance).
        if (transport !== undefined) {
          await this.safeCloseTransport(transport);
        }
        throw new Error(`MCP server "${serverId}" connection was cancelled.`);
      }

      state.client = client;
      state.transport = transport;
      state.initializedClientCapabilities = clientCapabilities;
      state.connectPromise = undefined;
      this.liveClientStates.set(serverId, state);

      // Auto-`setLoggingLevel("debug")` — gated on the server actually
      // advertising the logging capability. The DRAFT-2026-v1 stateless
      // preview synthesizes capabilities that omit `logging` (it can't
      // honor the call without an `initialize` round-trip), so firing
      // blindly would either no-op + warn or RPC-error. The adapter
      // itself is also tolerant (no-op + warning) — this guard avoids
      // the warning noise on every connect.
      if (client.getServerCapabilities?.()?.logging) {
        this.setLoggingLevel(serverId, "debug").catch(() => {});
      }

      return client;
    } catch (error) {
      try {
        await client?.close();
      } catch {
        // Ignore close errors
      }
      if (transport) {
        await this.safeCloseTransport(transport);
      }
      this.clearLiveState(serverId, {
        preserveRetryPromise: Boolean(state.retryPromise),
      });
      throw error;
    }
  }

  private async connectViaStdio(
    serverId: string,
    client: ManagedMcpClient,
    config: StdioServerConfig,
    timeout: number,
    state: LiveClientState
  ): Promise<Transport> {
    const underlying = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...this.getProcessEnvironment(), ...(config.env ?? {}) },
      stderr: config.stderr,
      cwd: config.cwd,
    });

    const logger = this.resolveRpcLogger(config);
    const transport = logger
      ? wrapTransportForLogging(serverId, logger, underlying)
      : underlying;

    const stderrDrain = this.createStdioStderrDrain(underlying);

    try {
      await client.connect(transport, { timeout });
    } catch (error) {
      const stderrOutput = stderrDrain.getCapturedOutput();
      stderrDrain.cleanup();
      throw this.annotateStdioConnectError(
        serverId,
        error,
        stderrOutput
      );
    }

    state.stdioStderrCleanup = stderrDrain.cleanup;
    return underlying;
  }

  private async connectViaHttp(
    serverId: string,
    client: ManagedMcpClient,
    config: HttpServerConfig,
    timeout: number,
    state: LiveClientState,
    wireOpts?: {
      wireMode: "legacy" | "stateless-draft-2026-v1";
      clientInfo: { name: string; version: string };
      assignClient: (next: ManagedMcpClient) => void;
    }
  ): Promise<Transport | undefined> {
    const url = new URL(config.url);

    let effectiveAuthProvider = config.authProvider;
    let effectiveAccessToken = config.accessToken;
    state.authProvider = undefined;

    if (config.refreshToken) {
      const trimmedRefresh = config.refreshToken.trim();
      const trimmedClientId = config.clientId?.trim();
      const trimmedClientSecret = config.clientSecret?.trim() || undefined;
      const trimmedAccessToken = config.accessToken?.trim();

      if (!trimmedRefresh) {
        throw new Error(
          `Server "${serverId}": "refreshToken" must not be empty.`
        );
      }
      if (trimmedAccessToken) {
        throw new Error(
          `Server "${serverId}": "refreshToken" and "accessToken" are mutually exclusive.`
        );
      }
      if (config.authProvider) {
        throw new Error(
          `Server "${serverId}": "refreshToken" and "authProvider" are mutually exclusive.`
        );
      }
      if (!trimmedClientId) {
        throw new Error(
          `Server "${serverId}": "clientId" is required when "refreshToken" is set.`
        );
      }
      if (config.requestInit?.headers) {
        const normalized = normalizeHeaders(config.requestInit.headers);
        if (getExistingAuthorization(normalized)) {
          throw new Error(
            `Server "${serverId}": "requestInit.headers.Authorization" must not be set when "refreshToken" is used.`
          );
        }
      }

      effectiveAuthProvider = new RefreshTokenOAuthProvider(
        trimmedClientId,
        trimmedRefresh,
        trimmedClientSecret
      );
      state.authProvider =
        effectiveAuthProvider instanceof RefreshTokenOAuthProvider
          ? effectiveAuthProvider
          : undefined;
      effectiveAccessToken = undefined;
    }

    const requestInit = buildRequestInit(
      effectiveAccessToken,
      config.requestInit
    );
    const preferSSE = config.preferSSE ?? url.pathname.endsWith("/sse");

    // DRAFT-2026-v1 stateless preview branch. The preview owns fetch
    // end-to-end and cannot be re-shaped after construction (per
    // `upstream_v2alpha_extension_points`), so it must be built HERE —
    // after auth / requestInit / 401 wiring is resolved. Streamable
    // HTTP POST only; legacy SSE / preferSSE is rejected up-front.
    if (
      wireOpts?.wireMode === "stateless-draft-2026-v1" &&
      wireOpts.assignClient
    ) {
      if (preferSSE) {
        throw new StatelessPreviewRequiresHttpTransport("sse");
      }
      // Build a header bag from the resolved `requestInit.headers` so
      // the preview's own-fetch sees the same statics legacy would.
      // `Authorization` is set by `getAccessToken`, so strip it from
      // the static set to avoid double-set (and to keep the OAuth
      // refresh path single-source).
      const staticHeaders: Record<string, string> = {};
      const ri = requestInit as
        | { headers?: Record<string, string> | Headers | undefined }
        | undefined;
      if (ri?.headers) {
        const headers =
          ri.headers instanceof Headers
            ? Object.fromEntries(ri.headers.entries())
            : ri.headers;
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === "authorization") continue;
          staticHeaders[k] = v;
        }
      }
      // Resolve the access token at send-time so OAuth refresh stays
      // single-source. Upstream HTTP transport adapts both shapes
      // automatically; we have to duplicate that logic here because the
      // preview owns its own fetch.
      //
      // - `AuthProvider` (lower-case `token()`): returns the current
      //   token, may refresh internally. `onUnauthorized` is the refresh
      //   hook on 401.
      // - `OAuthClientProvider` (`tokens()` + `saveTokens()`): returns
      //   cached only; running `auth(provider, { serverUrl })` from
      //   upstream performs the actual refresh exchange and writes the
      //   new tokens back via `saveTokens()`. Calling `tokens()` alone
      //   (the original implementation here) would have shipped the
      //   first request unauthenticated for refresh-token providers
      //   because nothing populates the cache up-front.
      const isAuthProvider = (
        p: unknown,
      ): p is { token: () => Promise<string | undefined>; onUnauthorized?: (ctx: unknown) => Promise<void> } =>
        !!p && typeof (p as { token?: unknown }).token === "function";
      const isOAuthClientProvider = (
        p: unknown,
      ): p is {
        tokens: () =>
          | { access_token?: string }
          | undefined
          | Promise<{ access_token?: string } | undefined>;
      } => !!p && typeof (p as { tokens?: unknown }).tokens === "function";
      const refreshOAuthTokens = async (): Promise<string | undefined> => {
        if (!isOAuthClientProvider(effectiveAuthProvider)) return undefined;
        // Lazy import to avoid pulling the auth helper into bundles that
        // never construct a stateless OAuth client.
        const { auth } = await import("@modelcontextprotocol/client");
        try {
          await auth(effectiveAuthProvider as never, { serverUrl: url });
        } catch {
          // `auth()` failures (refresh denied, network) surface as the
          // original 401 at the call site; we don't want to throw here
          // because the manager handles 401 explicitly.
          return undefined;
        }
        return (await effectiveAuthProvider.tokens())?.access_token;
      };
      const getAccessToken = async (): Promise<string | undefined> => {
        if (isAuthProvider(effectiveAuthProvider)) {
          return await effectiveAuthProvider.token();
        }
        if (isOAuthClientProvider(effectiveAuthProvider)) {
          const cached = (await effectiveAuthProvider.tokens())?.access_token;
          if (cached) return cached;
          // First call with a refresh-token provider: cache is empty,
          // run the OAuth flow to populate it before the first request.
          return await refreshOAuthTokens();
        }
        return effectiveAccessToken;
      };
      const on401 = async (): Promise<string | undefined> => {
        if (config.onUnauthorized) {
          const refreshed = await config.onUnauthorized({
            serverId,
            error: new MCPAuthError("HTTP 401 on stateless preview", 401),
          });
          return refreshed.accessToken;
        }
        if (isAuthProvider(effectiveAuthProvider)) {
          await effectiveAuthProvider.onUnauthorized?.({});
          return await effectiveAuthProvider.token();
        }
        if (isOAuthClientProvider(effectiveAuthProvider)) {
          return await refreshOAuthTokens();
        }
        return undefined;
      };
      const rpcLogger = this.resolveRpcLogger(config);
      const previewClient = createManagedMcpClient({
        mcpWireMode: "stateless-draft-2026-v1",
        transportKind: "http",
        preview: {
          url,
          clientInfo: wireOpts.clientInfo,
          staticHeaders,
          getAccessToken,
          on401,
          rpcLogger,
          serverId,
        },
      });
      await previewClient.connect(undefined as never, { timeout });
      // Swap the active client in the manager's state. Notification /
      // elicitation handlers re-applied on the new client so they
      // route to the preview adapter.
      wireOpts.assignClient(previewClient);
      this.notificationManager.applyToClient(serverId, previewClient);
      if (this.defaultProgressHandler) {
        applyProgressHandler(serverId, previewClient, this.defaultProgressHandler);
      }
      const elicitationCaps = (
        this.buildCapabilities(serverId, config) as Record<string, unknown>
      ).elicitation;
      if (elicitationCaps != null) {
        this.elicitationManager.applyToClient(serverId, previewClient);
      }
      if (config.onError) {
        previewClient.onerror = (error) => config.onError?.(error);
      }
      previewClient.onclose = () => {
        if (this.liveClientStates.get(serverId) === state) {
          this.clearClosedPendingConnectionState(serverId, state);
        }
      };
      // Stateless has no Transport object; return undefined to signal
      // that. Caller already widened the return type to
      // `Transport | undefined`.
      return undefined;
    }

    let streamableError: unknown;

    if (!preferSSE) {
      const streamableTransport = new StreamableHTTPClientTransport(url, {
        requestInit,
        reconnectionOptions: config.reconnectionOptions,
        authProvider: effectiveAuthProvider,
        sessionId: config.sessionId,
      });

      try {
        const logger = this.resolveRpcLogger(config);
        const wrapped = logger
          ? wrapTransportForLogging(serverId, logger, streamableTransport)
          : streamableTransport;
        await client.connect(wrapped, {
          timeout: Math.min(timeout, HTTP_CONNECT_TIMEOUT),
        });
        return streamableTransport;
      } catch (error) {
        streamableError = error;
        await this.safeCloseTransport(streamableTransport);
      }
    }

    const sseTransport = new SSEClientTransport(url, {
      requestInit,
      eventSourceInit: config.eventSourceInit,
      authProvider: effectiveAuthProvider,
    });

    try {
      const logger = this.resolveRpcLogger(config);
      const wrapped = logger
        ? wrapTransportForLogging(serverId, logger, sseTransport)
        : sseTransport;
      await client.connect(wrapped, { timeout });
      return sseTransport;
    } catch (error) {
      await this.safeCloseTransport(sseTransport);
      const streamableMessage = streamableError
        ? ` Streamable HTTP error: ${formatError(streamableError)}.`
        : "";
      const sseErrorMessage = formatError(error);
      const combinedErrorMessage =
        `${streamableMessage} SSE error: ${sseErrorMessage}`.trim();

      // Check for auth errors in both the SSE error and streamable error
      const sseAuthCheck = isAuthError(error);
      const streamableAuthCheck = streamableError
        ? isAuthError(streamableError)
        : { isAuth: false };

      if (sseAuthCheck.isAuth || streamableAuthCheck.isAuth) {
        const statusCode =
          sseAuthCheck.statusCode ?? streamableAuthCheck.statusCode;
        throw new MCPAuthError(
          `Authentication failed for MCP server "${serverId}": ${combinedErrorMessage}`,
          statusCode,
          { cause: error }
        );
      }

      throw new Error(
        `Failed to connect to MCP server "${serverId}" using HTTP transports.${streamableMessage} SSE error: ${sseErrorMessage}.`
      );
    }
  }

  private async safeCloseTransport(transport: Transport): Promise<void> {
    try {
      await transport.close();
    } catch {
      // Ignore close errors
    }
  }

  private getProcessEnvironment(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" && !entry[1].startsWith("()")
      )
    );
  }

  private createStdioStderrDrain(
    transport: StdioClientTransport
  ): { cleanup: () => void; getCapturedOutput: () => string } {
    const stderrStream = transport.stderr as NodeJS.ReadableStream | null;
    if (!stderrStream) {
      return {
        cleanup: () => {},
        getCapturedOutput: () => "",
      };
    }

    const maxCapturedChars = 16_384;
    let captured = "";
    let stopped = false;
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      captured += text;
      if (captured.length > maxCapturedChars) {
        captured = captured.slice(-maxCapturedChars);
      }
    };

    stderrStream.on("data", onData);

    return {
      cleanup: () => {
        if (!stopped) {
          stopped = true;
          stderrStream.removeListener("data", onData);
        }
      },
      getCapturedOutput: () => captured.trim(),
    };
  }

  private annotateStdioConnectError(
    serverId: string,
    error: unknown,
    stderrOutput: string
  ): Error {
    const baseMessage =
      error instanceof Error ? error.message : String(error);
    const stderrSection = stderrOutput
      ? `\n\nChild process stderr:\n${stderrOutput}`
      : "";
    const message = `Failed to connect to MCP server "${serverId}" via stdio: ${baseMessage}${stderrSection}`;

    if (error instanceof Error) {
      return new Error(message, { cause: error });
    }

    return new Error(message);
  }

  private async ensureConnected(
    serverId: string,
    signal?: AbortSignal
  ): Promise<void> {
    this.throwIfAborted(signal);

    const state = this.liveClientStates.get(serverId);
    if (state?.client) return;

    if (!this.registeredServers.has(serverId)) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }
    if (state?.retryPromise) {
      await this.awaitWithAbort(state.retryPromise, signal);
      return;
    }
    if (state?.connectPromise) {
      await this.awaitWithAbort(state.connectPromise, signal);
      return;
    }
    await this.connectToServerOnce(serverId, signal);
  }

  private getClientOrThrow(serverId: string): ManagedMcpClient {
    const state = this.liveClientStates.get(serverId);
    if (!state?.client) {
      throw new Error(`MCP server "${serverId}" is not connected.`);
    }
    return state.client;
  }

  private clearLiveState(
    serverId: string,
    options?: {
      preservePendingPromises?: boolean;
      preserveRetryPromise?: boolean;
    }
  ): void {
    const state = this.liveClientStates.get(serverId);
    state?.stdioStderrCleanup?.();

    if (!state) {
      this.toolsMetadataCache.delete(serverId);
      return;
    }

    delete state.client;
    delete state.transport;
    delete state.stdioStderrCleanup;
    delete state.initializedClientCapabilities;
    if (!options?.preservePendingPromises) {
      delete state.connectPromise;
    }
    if (!options?.preservePendingPromises && !options?.preserveRetryPromise) {
      delete state.retryPromise;
      delete state.authProvider;
    }

    if (state.connectPromise || state.retryPromise) {
      this.liveClientStates.set(serverId, state);
    } else {
      this.liveClientStates.delete(serverId);
    }
    this.toolsMetadataCache.delete(serverId);
  }

  private clearClosedPendingConnectionState(
    serverId: string,
    state: LiveClientState
  ): void {
    state.stdioStderrCleanup?.();

    const nextState: LiveClientState = {};
    if (state.connectPromise) {
      nextState.connectPromise = state.connectPromise;
    }
    if (state.retryPromise) {
      nextState.retryPromise = state.retryPromise;
    }
    if (state.authProvider) {
      nextState.authProvider = state.authProvider;
    }

    delete state.client;
    delete state.transport;
    delete state.stdioStderrCleanup;
    delete state.initializedClientCapabilities;

    if (nextState.connectPromise || nextState.retryPromise) {
      this.liveClientStates.set(serverId, nextState);
    } else {
      this.liveClientStates.delete(serverId);
    }
    this.toolsMetadataCache.delete(serverId);
  }

  private async destroyLiveState(
    serverId: string,
    options?: {
      preservePendingPromises?: boolean;
      preserveRetryPromise?: boolean;
      abortRetryOperations?: boolean;
    }
  ): Promise<void> {
    if (options?.abortRetryOperations !== false) {
      this.abortRetrySignals(serverId);
    }

    const state = this.liveClientStates.get(serverId);
    const client = state?.client;
    const transport = state?.transport;
    this.clearLiveState(serverId, options);
    if (!state) {
      return;
    }

    try {
      await client?.close();
    } catch {
      // Ignore close errors
    }

    if (transport) {
      await this.safeCloseTransport(transport);
    }
  }

  private buildServerReplayConfig(
    serverId: string,
    state: RegisteredServerState,
    liveState?: LiveClientState
  ): MCPServerReplayConfig | undefined {
    const { config } = state;
    if (!this.isHttpConfig(config)) {
      return undefined;
    }
    if (
      config.authProvider ||
      config.eventSourceInit ||
      config.reconnectionOptions ||
      config.sessionId
    ) {
      return undefined;
    }
    if (
      config.requestInit &&
      !this.hasReplayableRequestInit(config.requestInit, true)
    ) {
      return undefined;
    }

    const replayConfig: MCPServerReplayConfig = {
      serverId,
      url: config.url,
    };

    if (config.preferSSE !== undefined) {
      replayConfig.preferSSE = config.preferSSE;
    }

    if (config.refreshToken) {
      const configuredRefreshToken = config.refreshToken.trim();
      const currentAccessToken =
        liveState?.authProvider?.tokens()?.access_token;
      const currentRefreshToken = liveState?.authProvider
          ?.prepareTokenRequest()
          .get("refresh_token");
      const clientId = config.clientId?.trim();
      const clientSecret = config.clientSecret?.trim();

      if (currentRefreshToken && currentRefreshToken.trim()) {
        replayConfig.refreshToken = currentRefreshToken.trim();
      } else if (configuredRefreshToken) {
        replayConfig.refreshToken = configuredRefreshToken;
      } else if (currentAccessToken && currentAccessToken.trim()) {
        replayConfig.accessToken = currentAccessToken.trim();
      }
      if (clientId) {
        replayConfig.clientId = clientId;
      }
      if (clientSecret) {
        replayConfig.clientSecret = clientSecret;
      }

      return replayConfig.refreshToken || replayConfig.accessToken
        ? replayConfig
        : undefined;
    }

    const accessToken = this.extractReplayAccessToken(config);
    if (accessToken) {
      replayConfig.accessToken = accessToken;
    }

    return replayConfig;
  }

  private isHttpConfig(config: MCPServerConfig): config is HttpServerConfig {
    return !this.isStdioConfig(config);
  }

  private extractReplayAccessToken(
    config: HttpServerConfig
  ): string | undefined {
    const accessToken = config.accessToken?.trim();
    if (accessToken) {
      return accessToken;
    }

    if (
      !config.requestInit ||
      !this.hasReplayableRequestInit(config.requestInit)
    ) {
      return undefined;
    }

    return this.extractBearerAccessToken(config.requestInit.headers);
  }

  private hasReplayableRequestInit(
    requestInit: RequestInit,
    allowEmptyHeaders = false
  ): boolean {
    const { headers, ...rest } = requestInit;
    const hasUnsupportedOptions = Object.values(rest).some(
      (value) => value !== undefined
    );
    if (hasUnsupportedOptions) {
      return false;
    }

    const normalizedHeaders = normalizeHeaders(headers);
    const hasNonAuthHeaders = Object.keys(normalizedHeaders).some(
      (key) => key.toLowerCase() !== "authorization"
    );
    if (hasNonAuthHeaders) {
      return false;
    }

    if (Object.keys(normalizedHeaders).length === 0) {
      return allowEmptyHeaders;
    }

    return Boolean(this.extractBearerAccessToken(headers));
  }

  private extractBearerAccessToken(
    headers: HeadersInit | undefined
  ): string | undefined {
    const authorization = getExistingAuthorization(normalizeHeaders(headers));
    if (!authorization) {
      return undefined;
    }

    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return undefined;
    }

    const token = match[1]?.trim();
    return token ? token : undefined;
  }

  private withTimeout(
    serverId: string,
    options?: RequestOptions
  ): RequestOptions {
    const state = this.registeredServers.get(serverId);
    const timeout = state?.timeout ?? this.defaultTimeout;

    if (!options) return { timeout };
    if (options.timeout === undefined) return { ...options, timeout };
    return options;
  }

  private withProgressHandler(
    serverId: string,
    options?: RequestOptions
  ): RequestOptions {
    const mergedOptions = this.withTimeout(serverId, options);

    if (!mergedOptions.onprogress && this.defaultProgressHandler) {
      const progressToken = `${serverId}-request-${Date.now()}-${++this.progressTokenCounter}`;
      mergedOptions.onprogress = (progress) => {
        this.defaultProgressHandler!({
          serverId,
          progressToken,
          progress: progress.progress,
          total: progress.total,
          message: progress.message,
        });
      };
    }

    return mergedOptions;
  }

  private buildCapabilities(
    serverId: string,
    config: MCPServerConfig
  ): ClientCapabilityOptions {
    const hasElicitationHandler = this.elicitationManager.hasHandler(serverId);
    if (config.clientCapabilities) {
      const exactCapabilities = normalizeClientCapabilities(
        config.clientCapabilities
      ) as Record<string, unknown>;

      if (!hasElicitationHandler) {
        delete exactCapabilities.elicitation;
      }

      return exactCapabilities as ClientCapabilityOptions;
    }

    const configuredCapabilities =
      mergeClientCapabilities(this.defaultCapabilities, config.capabilities);

    return applyRuntimeClientCapabilities(configuredCapabilities, {
      elicitation: hasElicitationHandler,
    });
  }

  private hasNegotiatedElicitation(state?: LiveClientState): boolean {
    const capabilities = state?.initializedClientCapabilities as
      | Record<string, unknown>
      | undefined;
    return capabilities?.elicitation != null;
  }

  private resolveRpcLogger(config: MCPServerConfig): RpcLogger | undefined {
    if (config.rpcLogger) return config.rpcLogger;
    if (config.logJsonRpc || this.defaultLogJsonRpc)
      return createDefaultRpcLogger();
    if (this.defaultRpcLogger) return this.defaultRpcLogger;
    return undefined;
  }

  private cacheToolsMetadata(
    serverId: string,
    tools: Array<{ name: string; _meta?: any }>
  ): void {
    const metadataMap = new Map<string, any>();
    for (const tool of tools) {
      if (tool._meta) {
        metadataMap.set(tool.name, tool._meta);
      }
    }
    this.toolsMetadataCache.set(serverId, metadataMap);
  }

  private isStdioConfig(config: MCPServerConfig): config is StdioServerConfig {
    return "command" in config;
  }

  private isExecuteToolRequest(
    value: ClientRequestOptions | ExecuteToolRequest | undefined
  ): value is ExecuteToolRequest {
    return Boolean(
      value &&
      typeof value === "object" &&
      ("request" in value || "retry" in value)
    );
  }

  private normalizeExecuteToolRequest(
    options?: ClientRequestOptions | ExecuteToolRequest,
    taskOptions?: TaskOptions
  ): ExecuteToolRequest {
    if (this.isExecuteToolRequest(options)) {
      return options;
    }

    return {
      request: options,
      task: taskOptions,
    };
  }

  private async runRetryableReadOperation<T>(
    serverId: string,
    options: RequestOptions | undefined,
    operation: (client: ManagedMcpClient) => Promise<T>
  ): Promise<T> {
    return this.runRetriedOperation(
      serverId,
      options,
      this.defaultRetryPolicy,
      async (signal) => {
        await this.ensureConnected(serverId, signal);
        return operation(this.getClientOrThrow(serverId));
      },
      { resetConnectionOnRetry: false }
    );
  }

  private async runRetriedOperation<T>(
    serverId: string,
    options: RequestOptions | undefined,
    retryPolicy: RetryPolicy,
    operation: (signal?: AbortSignal) => Promise<T>,
    config: {
      resetConnectionOnRetry?: boolean;
    } = {}
  ): Promise<T> {
    const { signal, cleanup } = this.createRetrySignal(serverId, options?.signal);

    const runWithTransientRetry = () =>
      retryWithPolicy({
        policy: retryPolicy,
        signal,
        operation: async () => this.awaitWithAbort(operation(signal), signal),
        shouldRetryError: (error) => isRetryableTransientError(error),
        onRetry: async () => {
          if (config.resetConnectionOnRetry) {
            await this.destroyLiveState(serverId, {
              abortRetryOperations: false,
            });
          }
        },
      });

    try {
      try {
        return await runWithTransientRetry();
      } catch (error) {
        const refreshed = await this.refreshAccessTokenAfterUnauthorized(
          serverId,
          error,
          signal
        );
        if (!refreshed) {
          throw error;
        }
        return await runWithTransientRetry();
      }
    } finally {
      cleanup();
    }
  }

  private async refreshAccessTokenAfterUnauthorized(
    serverId: string,
    error: unknown,
    signal: AbortSignal
  ): Promise<boolean> {
    if (!isUnauthorized401(error)) {
      return false;
    }

    const registeredState = this.registeredServers.get(serverId);
    const config = registeredState?.config;
    const onUnauthorized =
      config && this.isHttpConfig(config) ? config.onUnauthorized : undefined;
    if (
      !config ||
      !this.isHttpConfig(config) ||
      !onUnauthorized ||
      config.authProvider ||
      config.refreshToken
    ) {
      return false;
    }

    let refreshPromise = this.unauthorizedRefreshInFlight.get(serverId);
    if (!refreshPromise) {
      refreshPromise = (async () => {
        const result = await onUnauthorized({ serverId, error });
        const accessToken = result?.accessToken?.trim();
        if (!accessToken) {
          throw new Error(
            `Server "${serverId}" onUnauthorized returned an empty access token.`
          );
        }
        return accessToken;
      })()
        .finally(() => {
          if (this.unauthorizedRefreshInFlight.get(serverId) === refreshPromise) {
            this.unauthorizedRefreshInFlight.delete(serverId);
          }
        });
      this.unauthorizedRefreshInFlight.set(serverId, refreshPromise);
    }

    const accessToken = await this.awaitWithAbort(refreshPromise, signal);
    const latestState = this.registeredServers.get(serverId);
    const latestConfig = latestState?.config;
    if (!latestState || !latestConfig || !this.isHttpConfig(latestConfig)) {
      return false;
    }

    latestState.config = {
      ...latestConfig,
      accessToken,
      requestInit: stripAuthorizationFromRequestInit(latestConfig.requestInit),
    };
    await this.destroyLiveState(serverId, {
      abortRetryOperations: false,
    });
    return true;
  }

  private createRetrySignal(
    serverId: string,
    callerSignal?: AbortSignal
  ): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    let controllers = this.retryAbortControllers.get(serverId);
    if (!controllers) {
      controllers = new Set();
      this.retryAbortControllers.set(serverId, controllers);
    }
    controllers.add(controller);

    const abortFromCaller = () => {
      if (!controller.signal.aborted) {
        controller.abort(callerSignal?.reason);
      }
    };

    if (callerSignal?.aborted) {
      abortFromCaller();
    } else {
      callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    return {
      signal: controller.signal,
      cleanup: () => {
        callerSignal?.removeEventListener("abort", abortFromCaller);
        const currentControllers = this.retryAbortControllers.get(serverId);
        if (!currentControllers) {
          return;
        }
        currentControllers.delete(controller);
        if (currentControllers.size === 0) {
          this.retryAbortControllers.delete(serverId);
        }
      },
    };
  }

  private abortRetrySignals(serverId: string): void {
    const controllers = this.retryAbortControllers.get(serverId);
    if (!controllers) {
      return;
    }

    this.retryAbortControllers.delete(serverId);
    const error = new Error(`MCP server "${serverId}" was disconnected.`);
    error.name = "AbortError";

    for (const controller of controllers) {
      if (!controller.signal.aborted) {
        controller.abort(error);
      }
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) {
      return;
    }

    if (signal.reason instanceof Error) {
      throw signal.reason;
    }

    const error = new Error(
      signal.reason == null
        ? "The operation was aborted."
        : String(signal.reason)
    );
    error.name = "AbortError";
    throw error;
  }

  private async awaitWithAbort<T>(
    promise: Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    this.throwIfAborted(signal);

    if (!signal) {
      return promise;
    }

    return await new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        cleanup();
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : Object.assign(
                new Error(
                  signal.reason == null
                    ? "The operation was aborted."
                    : String(signal.reason)
                ),
                { name: "AbortError" }
              )
        );
      };

      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
      };

      signal.addEventListener("abort", onAbort, { once: true });

      promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        }
      );
    });
  }
}
