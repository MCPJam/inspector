/**
 * MCPClientManager - Manages multiple MCP server connections
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  CreateTaskResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  LoggingLevel,
  ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolSet } from "ai";

import type {
  MCPClientManagerConfig,
  MCPClientManagerOptions,
  MCPServerConfig,
  StdioServerConfig,
  HttpServerConfig,
  ManagedClientState,
  MCPConnectionStatus,
  ServerSummary,
  ClientCapabilityOptions,
  ExecuteToolArguments,
  TaskOptions,
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
} from "./types.js";

import {
  DEFAULT_CLIENT_VERSION,
  DEFAULT_TIMEOUT,
  HTTP_CONNECT_TIMEOUT,
} from "./constants.js";
import { isMethodUnavailableError, formatError } from "./error-utils.js";
import {
  buildRequestInit,
  wrapTransportForLogging,
  createDefaultRpcLogger,
} from "./transport-utils.js";
import {
  NotificationManager,
  applyProgressHandler,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
  type NotificationSchema,
  type NotificationHandler,
} from "./notification-handlers.js";
import { ElicitationManager } from "./elicitation.js";
import {
  listTasks as tasksListTasks,
  getTask as tasksGetTask,
  getTaskResult as tasksGetTaskResult,
  cancelTask as tasksCancelTask,
  supportsTasksForToolCalls,
  supportsTasksList,
  supportsTasksCancel,
  TaskStatusNotificationSchema,
} from "./tasks.js";
import {
  convertMCPToolsToVercelTools,
  type ToolSchemaOverrides,
} from "./tool-converters.js";

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
 *     url: new URL("https://my-server.com/mcp"),
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
  private readonly clientStates = new Map<string, ManagedClientState>();
  private readonly toolsMetadataCache = new Map<string, Map<string, any>>();

  // Managers for specific features
  private readonly notificationManager = new NotificationManager();
  private readonly elicitationManager = new ElicitationManager();

  // Default options
  private readonly defaultClientName: string | undefined;
  private readonly defaultClientVersion: string;
  private readonly defaultCapabilities: ClientCapabilityOptions;
  private readonly defaultTimeout: number;
  private readonly defaultLogJsonRpc: boolean;
  private readonly defaultRpcLogger?: RpcLogger;
  private readonly defaultProgressHandler?: ProgressHandler;

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
    this.defaultCapabilities = { ...(options.defaultCapabilities ?? {}) };
    this.defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT;
    this.defaultLogJsonRpc = options.defaultLogJsonRpc ?? false;
    this.defaultRpcLogger = options.rpcLogger;
    this.defaultProgressHandler = options.progressHandler;

    // Start connecting to all configured servers
    for (const [id, config] of Object.entries(servers)) {
      void this.connectToServer(id, config);
    }
  }

  // ===========================================================================
  // Server Management
  // ===========================================================================

  /**
   * Lists all registered server IDs.
   */
  listServers(): string[] {
    return Array.from(this.clientStates.keys());
  }

  /**
   * Checks if a server is registered.
   */
  hasServer(serverId: string): boolean {
    return this.clientStates.has(serverId);
  }

  /**
   * Gets summaries for all registered servers.
   */
  getServerSummaries(): ServerSummary[] {
    return Array.from(this.clientStates.entries()).map(([serverId, state]) => ({
      id: serverId,
      status: this.getConnectionStatus(serverId),
      config: state.config,
    }));
  }

  /**
   * Gets the connection status for a server.
   */
  getConnectionStatus(serverId: string): MCPConnectionStatus {
    const state = this.clientStates.get(serverId);
    if (state?.promise) return "connecting";
    if (state?.client) return "connected";
    return "disconnected";
  }

  /**
   * Gets the configuration for a server.
   */
  getServerConfig(serverId: string): MCPServerConfig | undefined {
    return this.clientStates.get(serverId)?.config;
  }

  /**
   * Gets the capabilities reported by a server.
   */
  getServerCapabilities(serverId: string): ServerCapabilities | undefined {
    return this.clientStates.get(serverId)?.client?.getServerCapabilities();
  }

  /**
   * Gets the underlying MCP Client for a server.
   */
  getClient(serverId: string): Client | undefined {
    return this.clientStates.get(serverId)?.client;
  }

  /**
   * Gets initialization information for a connected server.
   */
  getInitializationInfo(serverId: string) {
    const state = this.clientStates.get(serverId);
    const client = state?.client;
    if (!client) return undefined;

    const config = state.config;
    let transportType: string;
    if (this.isStdioConfig(config)) {
      transportType = "stdio";
    } else {
      transportType =
        config.preferSSE || config.url.pathname.endsWith("/sse")
          ? "sse"
          : "streamable-http";
    }

    let protocolVersion: string | undefined;
    if (state.transport) {
      protocolVersion = (state.transport as any)._protocolVersion;
    }

    return {
      protocolVersion,
      transport: transportType,
      serverCapabilities: client.getServerCapabilities(),
      serverVersion: client.getServerVersion(),
      instructions: client.getInstructions(),
      clientCapabilities: this.buildCapabilities(config),
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
  ): Promise<Client> {
    const timeout = config.timeout ?? this.defaultTimeout;
    const existingState = this.clientStates.get(serverId);

    if (existingState?.client) {
      throw new Error(`MCP server "${serverId}" is already connected.`);
    }

    const state: ManagedClientState = existingState ?? { config, timeout };
    state.config = config;
    state.timeout = timeout;

    // Reuse existing connection promise if in-flight
    if (state.promise) {
      this.clientStates.set(serverId, state);
      return state.promise;
    }

    const connectionPromise = this.performConnection(
      serverId,
      config,
      timeout,
      state
    );
    state.promise = connectionPromise;
    this.clientStates.set(serverId, state);

    return connectionPromise;
  }

  /**
   * Disconnects from a server.
   */
  async disconnectServer(serverId: string): Promise<void> {
    const state = this.clientStates.get(serverId);
    if (!state?.client) return;

    try {
      await state.client.close();
    } catch {
      // Ignore close errors
    } finally {
      if (state.transport) {
        await this.safeCloseTransport(state.transport);
      }
      this.resetState(serverId);
    }
  }

  /**
   * Removes a server from the manager entirely.
   */
  async removeServer(serverId: string): Promise<void> {
    await this.disconnectServer(serverId);
    this.notificationManager.clearServer(serverId);
    this.elicitationManager.clearServer(serverId);
  }

  /**
   * Disconnects from all servers.
   */
  async disconnectAllServers(): Promise<void> {
    const serverIds = this.listServers();
    await Promise.all(serverIds.map((id) => this.disconnectServer(id)));

    for (const serverId of serverIds) {
      this.notificationManager.clearServer(serverId);
      this.elicitationManager.clearServer(serverId);
    }
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
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);

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
  }

  /**
   * Gets tools from multiple servers (or all servers if none specified).
   */
  async getTools(serverIds?: string[]): Promise<ListToolsResult> {
    const targetIds = serverIds?.length ? serverIds : this.listServers();

    const toolLists = await Promise.all(
      targetIds.map(async (serverId) => {
        await this.ensureConnected(serverId);
        const result = await this.listTools(serverId);
        return result.tools;
      })
    );

    return { tools: toolLists.flat() } as ListToolsResult;
  }

  /**
   * Gets cached tool metadata for a server.
   */
  getAllToolsMetadata(serverId: string): Record<string, Record<string, any>> {
    const metadataMap = this.toolsMetadataCache.get(serverId);
    return metadataMap ? Object.fromEntries(metadataMap) : {};
  }

  /**
   * Gets tools formatted for Vercel AI SDK.
   *
   * @param serverIds - Server IDs to get tools from (or all if omitted)
   * @param options - Schema options
   * @returns ToolSet compatible with Vercel AI SDK
   */
  async getToolsForAiSdk(
    serverIds?: string[] | string,
    options: { schemas?: ToolSchemaOverrides | "automatic" } = {}
  ): Promise<ToolSet> {
    const ids = Array.isArray(serverIds)
      ? serverIds
      : serverIds
        ? [serverIds]
        : this.listServers();

    const perServerTools = await Promise.all(
      ids.map(async (id) => {
        try {
          await this.ensureConnected(id);
          const listToolsResult = await this.listTools(id);

          // Filter out app-only tools (visibility: ["app"]) per SEP-1865
          const filteredTools = {
            ...listToolsResult,
            tools: listToolsResult.tools.filter((tool) => {
              const visibility = (tool._meta?.ui as any)?.visibility as
                | Array<"model" | "app">
                | undefined;
              if (!visibility) return true;
              return !(visibility.length === 1 && visibility[0] === "app");
            }),
          };

          const tools = await convertMCPToolsToVercelTools(filteredTools, {
            schemas: options.schemas,
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
              return CallToolResultSchema.parse(result);
            },
          });

          // Attach server ID metadata to each tool
          for (const [_name, tool] of Object.entries(tools)) {
            (tool as any)._serverId = id;
          }
          return tools;
        } catch (error) {
          if (isMethodUnavailableError(error, "tools/list")) {
            return {} as ToolSet;
          }
          throw error;
        }
      })
    );

    // Flatten (last-in wins for name collisions)
    const flattened: ToolSet = {};
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
    args: ExecuteToolArguments = {},
    options?: ClientRequestOptions,
    taskOptions?: TaskOptions
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);

    const mergedOptions = this.withProgressHandler(serverId, options);
    const callParams = { name: toolName, arguments: args };

    if (taskOptions !== undefined) {
      // Task-augmented tool call per MCP Tasks spec
      const taskValue =
        taskOptions.ttl !== undefined ? { ttl: taskOptions.ttl } : {};
      const result = await client.request(
        { method: "tools/call", params: { ...callParams, task: taskValue } },
        CreateTaskResultSchema,
        mergedOptions
      );
      return {
        task: result.task,
        _meta: {
          "io.modelcontextprotocol/model-immediate-response": `Task ${result.task.taskId} created with status: ${result.task.status}`,
        },
      };
    }

    return client.callTool(callParams, CallToolResultSchema, mergedOptions);
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
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);

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
  }

  /**
   * Reads a resource from a server.
   */
  async readResource(
    serverId: string,
    params: ReadResourceParams,
    options?: ClientRequestOptions
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);
    return client.readResource(
      params,
      this.withProgressHandler(serverId, options)
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
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);
    return client.listResourceTemplates(
      params,
      this.withTimeout(serverId, options)
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
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);

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
  }

  /**
   * Gets a prompt from a server.
   */
  async getPrompt(
    serverId: string,
    params: GetPromptParams,
    options?: ClientRequestOptions
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);
    return client.getPrompt(
      params,
      this.withProgressHandler(serverId, options)
    );
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Pings a server to check connectivity.
   */
  pingServer(serverId: string, options?: RequestOptions): void {
    const client = this.getClientOrThrow(serverId);
    try {
      client.ping(options);
    } catch (error) {
      throw new Error(
        `Failed to ping MCP server "${serverId}": ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
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
    const state = this.clientStates.get(serverId);
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
    schema: NotificationSchema,
    handler: NotificationHandler
  ): void {
    this.notificationManager.addHandler(serverId, schema, handler);

    const client = this.clientStates.get(serverId)?.client;
    if (client) {
      client.setNotificationHandler(
        schema,
        this.notificationManager.createDispatcher(serverId, schema)
      );
    }
  }

  /**
   * Registers a handler for resource list changes.
   */
  onResourceListChanged(serverId: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverId,
      ResourceListChangedNotificationSchema,
      handler
    );
  }

  /**
   * Registers a handler for resource updates.
   */
  onResourceUpdated(serverId: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverId,
      ResourceUpdatedNotificationSchema,
      handler
    );
  }

  /**
   * Registers a handler for prompt list changes.
   */
  onPromptListChanged(serverId: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverId,
      PromptListChangedNotificationSchema,
      handler
    );
  }

  /**
   * Registers a handler for task status changes.
   */
  onTaskStatusChanged(serverId: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverId,
      TaskStatusNotificationSchema,
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
    if (!this.clientStates.has(serverId)) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }
    this.elicitationManager.setHandler(serverId, handler);

    const client = this.clientStates.get(serverId)?.client;
    if (client) {
      this.elicitationManager.applyToClient(serverId, client);
    }
  }

  /**
   * Clears a server-specific elicitation handler.
   */
  clearElicitationHandler(serverId: string): void {
    this.elicitationManager.clearHandler(serverId);
    const client = this.clientStates.get(serverId)?.client;
    if (client) {
      if (this.elicitationManager.getGlobalCallback()) {
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
    for (const [serverId, state] of this.clientStates.entries()) {
      if (state.client) {
        this.elicitationManager.applyToClient(serverId, state.client);
      }
    }
  }

  /**
   * Clears the global elicitation callback.
   */
  clearElicitationCallback(): void {
    this.elicitationManager.clearGlobalCallback();
    for (const [serverId, state] of this.clientStates.entries()) {
      if (!state.client) continue;
      if (this.elicitationManager.getHandler(serverId)) {
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
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);
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
  }

  /**
   * Gets a task by ID.
   */
  async getTask(
    serverId: string,
    taskId: string,
    options?: ClientRequestOptions
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);
    return tasksGetTask(client, taskId, this.withTimeout(serverId, options));
  }

  /**
   * Gets the result of a completed task.
   */
  async getTaskResult(
    serverId: string,
    taskId: string,
    options?: ClientRequestOptions
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);
    return tasksGetTaskResult(
      client,
      taskId,
      this.withTimeout(serverId, options)
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

  private async performConnection(
    serverId: string,
    config: MCPServerConfig,
    timeout: number,
    state: ManagedClientState
  ): Promise<Client> {
    try {
      const client = new Client(
        {
          name: this.defaultClientName ?? serverId,
          version: config.version ?? this.defaultClientVersion,
        },
        { capabilities: this.buildCapabilities(config) }
      );

      // Apply handlers
      this.notificationManager.applyToClient(serverId, client);
      if (this.defaultProgressHandler) {
        applyProgressHandler(serverId, client, this.defaultProgressHandler);
      }
      this.elicitationManager.applyToClient(serverId, client);

      if (config.onError) {
        client.onerror = (error) => config.onError?.(error);
      }

      client.onclose = () => this.resetState(serverId);

      let transport: Transport;
      if (this.isStdioConfig(config)) {
        transport = await this.connectViaStdio(
          serverId,
          client,
          config,
          timeout
        );
      } else {
        transport = await this.connectViaHttp(
          serverId,
          client,
          config,
          timeout
        );
      }

      state.client = client;
      state.transport = transport;
      state.promise = undefined;
      this.clientStates.set(serverId, state);

      // Set logging level (ignore errors)
      this.setLoggingLevel(serverId, "debug").catch(() => {});

      return client;
    } catch (error) {
      this.resetState(serverId);
      throw error;
    }
  }

  private async connectViaStdio(
    serverId: string,
    client: Client,
    config: StdioServerConfig,
    timeout: number
  ): Promise<Transport> {
    const underlying = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    });

    const logger = this.resolveRpcLogger(config);
    const transport = logger
      ? wrapTransportForLogging(serverId, logger, underlying)
      : underlying;

    await client.connect(transport, { timeout });
    return underlying;
  }

  private async connectViaHttp(
    serverId: string,
    client: Client,
    config: HttpServerConfig,
    timeout: number
  ): Promise<Transport> {
    const requestInit = buildRequestInit(
      config.accessToken,
      config.requestInit
    );
    const preferSSE = config.preferSSE ?? config.url.pathname.endsWith("/sse");
    let streamableError: unknown;

    if (!preferSSE) {
      const streamableTransport = new StreamableHTTPClientTransport(
        config.url,
        {
          requestInit,
          reconnectionOptions: config.reconnectionOptions,
          authProvider: config.authProvider,
          sessionId: config.sessionId,
        }
      );

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

    const sseTransport = new SSEClientTransport(config.url, {
      requestInit,
      eventSourceInit: config.eventSourceInit,
      authProvider: config.authProvider,
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
      throw new Error(
        `Failed to connect to MCP server "${serverId}" using HTTP transports.${streamableMessage} SSE error: ${formatError(error)}.`
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

  private async ensureConnected(serverId: string): Promise<void> {
    const state = this.clientStates.get(serverId);
    if (state?.client) return;

    if (!state) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }
    if (state.promise) {
      await state.promise;
      return;
    }
    await this.connectToServer(serverId, state.config);
  }

  private getClientOrThrow(serverId: string): Client {
    const state = this.clientStates.get(serverId);
    if (!state?.client) {
      throw new Error(`MCP server "${serverId}" is not connected.`);
    }
    return state.client;
  }

  private resetState(serverId: string): void {
    this.clientStates.delete(serverId);
    this.toolsMetadataCache.delete(serverId);
  }

  private withTimeout(
    serverId: string,
    options?: RequestOptions
  ): RequestOptions {
    const state = this.clientStates.get(serverId);
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

  private buildCapabilities(config: MCPServerConfig): ClientCapabilityOptions {
    const capabilities: ClientCapabilityOptions = {
      ...this.defaultCapabilities,
      ...(config.capabilities ?? {}),
    };
    if (!capabilities.elicitation) {
      capabilities.elicitation = {};
    }
    return capabilities;
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
}
