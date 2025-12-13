import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { SSEClientTransportOptions } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { StreamableHTTPClientTransportOptions } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  ElicitRequest,
  ElicitResult,
  JSONRPCMessage,
  LoggingLevel,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import {
  convertMCPToolsToVercelTools,
  type ConvertedToolSet,
  type ToolSchemaOverrides,
} from "./tool-converters.js";
import type { ToolCallOptions, ToolSet } from "ai";
type ClientCapabilityOptions = NonNullable<ClientOptions["capabilities"]>;

type BaseServerConfig = {
  capabilities?: ClientCapabilityOptions;
  timeout?: number;
  version?: string;
  onError?: (error: unknown) => void;
  // Enable simple console logging of JSON-RPC traffic for this server
  logJsonRpc?: boolean;
  // Custom logger for JSON-RPC traffic; overrides logJsonRpc when provided
  rpcLogger?: (event: {
    direction: "send" | "receive";
    message: unknown;
    serverId: string;
  }) => void;
};

type StdioServerConfig = BaseServerConfig & {
  command: string;
  args?: string[];
  env?: Record<string, string>;

  url?: never;
  requestInit?: never;
  eventSourceInit?: never;
  authProvider?: never;
  reconnectionOptions?: never;
  sessionId?: never;
  preferSSE?: never;
};

type HttpServerConfig = BaseServerConfig & {
  url: URL;
  requestInit?: StreamableHTTPClientTransportOptions["requestInit"];
  eventSourceInit?: SSEClientTransportOptions["eventSourceInit"];
  authProvider?: StreamableHTTPClientTransportOptions["authProvider"];
  reconnectionOptions?: StreamableHTTPClientTransportOptions["reconnectionOptions"];
  sessionId?: StreamableHTTPClientTransportOptions["sessionId"];
  preferSSE?: boolean;

  command?: never;
  args?: never;
  env?: never;
};

export type MCPServerConfig = StdioServerConfig | HttpServerConfig;
export type MCPClientManagerConfig = Record<string, MCPServerConfig>;

type NotificationSchema = Parameters<Client["setNotificationHandler"]>[0];
type NotificationHandler = Parameters<Client["setNotificationHandler"]>[1];

interface ManagedClientState {
  config: MCPServerConfig;
  timeout: number;
  client?: Client;
  transport?: Transport;
  promise?: Promise<Client>;
}

// Pending state is tracked inside ManagedClientState.promise

type ClientRequestOptions = RequestOptions;
type CallToolOptions = RequestOptions;

type ListResourcesParams = Parameters<Client["listResources"]>[0];
type ListResourceTemplatesParams = Parameters<
  Client["listResourceTemplates"]
>[0];
type ReadResourceParams = Parameters<Client["readResource"]>[0];
type SubscribeResourceParams = Parameters<Client["subscribeResource"]>[0];
type UnsubscribeResourceParams = Parameters<Client["unsubscribeResource"]>[0];
type ListPromptsParams = Parameters<Client["listPrompts"]>[0];
type GetPromptParams = Parameters<Client["getPrompt"]>[0];
type ListToolsResult = Awaited<ReturnType<Client["listTools"]>>;

export type MCPConnectionStatus = "connected" | "connecting" | "disconnected";
type ServerSummary = {
  id: string;
  status: MCPConnectionStatus;
  config?: MCPServerConfig;
};

export type ExecuteToolArguments = Record<string, unknown>;
export type ElicitationHandler = (
  params: ElicitRequest["params"],
) => Promise<ElicitResult> | ElicitResult;

export class MCPClientManager {
  private readonly clientStates = new Map<string, ManagedClientState>();
  private readonly notificationHandlers = new Map<
    string,
    Map<NotificationSchema, Set<NotificationHandler>>
  >();
  private readonly elicitationHandlers = new Map<string, ElicitationHandler>();
  private readonly toolsMetadataCache = new Map<string, Map<string, any>>();
  private readonly defaultClientVersion: string;
  private readonly defaultClientName: string | undefined;
  private readonly defaultCapabilities: ClientCapabilityOptions;
  private readonly defaultTimeout: number;
  private defaultLogJsonRpc: boolean = false;

  private defaultRpcLogger?: (event: {
    direction: "send" | "receive";
    message: unknown;
    serverId: string;
  }) => void;
  private elicitationCallback?: (request: {
    requestId: string;
    message: string;
    schema: unknown;
  }) => Promise<ElicitResult> | ElicitResult;
  private readonly pendingElicitations = new Map<
    string,
    {
      resolve: (value: ElicitResult) => void;
      reject: (error: unknown) => void;
    }
  >();

  constructor(
    servers: MCPClientManagerConfig = {},
    options: {
      defaultClientName?: string;
      defaultClientVersion?: string;
      defaultCapabilities?: ClientCapabilityOptions;
      defaultTimeout?: number;
      defaultLogJsonRpc?: boolean;
      rpcLogger?: (event: {
        direction: "send" | "receive";
        message: unknown;
        serverId: string;
      }) => void;
    } = {},
  ) {
    this.defaultClientVersion = options.defaultClientVersion ?? "1.0.0";
    this.defaultClientName = options.defaultClientName ?? undefined;
    this.defaultCapabilities = { ...(options.defaultCapabilities ?? {}) };
    this.defaultTimeout =
      options.defaultTimeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
    this.defaultLogJsonRpc = options.defaultLogJsonRpc ?? false;
    this.defaultRpcLogger = options.rpcLogger;

    for (const [id, config] of Object.entries(servers)) {
      void this.connectToServer(id, config);
    }
  }

  listServers(): string[] {
    return Array.from(this.clientStates.keys());
  }

  hasServer(serverId: string): boolean {
    return this.clientStates.has(serverId);
  }

  getServerSummaries(): ServerSummary[] {
    return Array.from(this.clientStates.entries()).map(([serverId, state]) => ({
      id: serverId,
      status: this.getConnectionStatusByAttemptingPing(serverId),
      config: state.config,
    }));
  }

  getConnectionStatusByAttemptingPing(serverId: string): MCPConnectionStatus {
    const state = this.clientStates.get(serverId);
    if (state?.promise) {
      return "connecting";
    }
    const client = state?.client;
    if (!client) {
      return "disconnected";
    }
    try {
      client.ping();
      return "connected";
    } catch (error) {
      return "disconnected";
    }
  }

  getServerConfig(serverId: string): MCPServerConfig | undefined {
    return this.clientStates.get(serverId)?.config;
  }

  getInitializationInfo(serverId: string) {
    const state = this.clientStates.get(serverId);
    const client = state?.client;
    if (!client) {
      return undefined;
    }

    // Determine transport type from config
    const config = state.config;
    let transportType: string;
    if (this.isStdioConfig(config)) {
      transportType = "stdio";
    } else {
      // Check if using SSE or Streamable HTTP based on URL or preference
      transportType =
        config.preferSSE || config.url.pathname.endsWith("/sse")
          ? "sse"
          : "streamable-http";
    }

    // Try to get protocol version from transport if available
    let protocolVersion: string | undefined;
    if (state.transport) {
      // Access internal protocol version if available
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

  async connectToServer(
    serverId: string,
    config: MCPServerConfig,
  ): Promise<Client> {
    const timeout = this.getTimeout(config);
    const existingState = this.clientStates.get(serverId);
    if (existingState?.client) {
      throw new Error(`MCP server "${serverId}" is already connected.`);
    }

    const state: ManagedClientState = existingState ?? {
      config,
      timeout,
    };
    // Update config/timeout on every call
    state.config = config;
    state.timeout = timeout;
    // If connection is in-flight, reuse the promise
    if (state.promise) {
      this.clientStates.set(serverId, state);
      return state.promise;
    }

    const connectionPromise = (async () => {
      const client = new Client(
        {
          name: this.defaultClientName ? `${this.defaultClientName}` : serverId,
          version: config.version ?? this.defaultClientVersion,
        },
        {
          capabilities: this.buildCapabilities(config),
        },
      );

      this.applyNotificationHandlers(serverId, client);
      this.applyElicitationHandler(serverId, client);

      if (config.onError) {
        client.onerror = (error) => {
          config.onError?.(error);
        };
      }

      client.onclose = () => {
        this.resetState(serverId);
      };

      let transport: Transport;
      if (this.isStdioConfig(config)) {
        transport = await this.connectViaStdio(
          serverId,
          client,
          config,
          timeout,
        );
      } else {
        transport = await this.connectViaHttp(
          serverId,
          client,
          config,
          timeout,
        );
      }

      state.client = client;
      state.transport = transport;
      // clear pending
      state.promise = undefined;
      this.clientStates.set(serverId, state);
      // Set logging level if supported (ignore errors if server doesn't support it)
      this.setLoggingLevel(serverId, "debug").catch(() => {
        // Silently ignore - server may not support logging/setLevel
      });
      return client;
    })().catch((error) => {
      this.resetState(serverId);
      throw error;
    });

    state.promise = connectionPromise;
    this.clientStates.set(serverId, state);
    return connectionPromise;
  }

  async disconnectServer(serverId: string): Promise<void> {
    const connectionStatus = this.getConnectionStatusByAttemptingPing(serverId);
    if (connectionStatus !== "connected") {
      return;
    }
    const client = this.getClientById(serverId);
    try {
      await client.close();
    } finally {
      if (client.transport) {
        await this.safeCloseTransport(client.transport);
      }
      this.resetState(serverId);
    }
  }

  removeServer(serverId: string): void {
    this.resetState(serverId);
    this.notificationHandlers.delete(serverId);
    this.elicitationHandlers.delete(serverId);
  }

  async disconnectAllServers(): Promise<void> {
    const serverIds = this.listServers();
    await Promise.all(
      serverIds.map((serverId) => this.disconnectServer(serverId)),
    );

    for (const serverId of serverIds) {
      this.resetState(serverId);
      this.notificationHandlers.delete(serverId);
      this.elicitationHandlers.delete(serverId);
    }
  }

  async listTools(
    serverId: string,
    params?: Parameters<Client["listTools"]>[0],
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    try {
      const result = await client.listTools(
        params,
        this.withTimeout(serverId, options),
      );

      const metadataMap = new Map<string, any>();
      for (const tool of result.tools) {
        if (tool._meta) {
          metadataMap.set(tool.name, tool._meta);
        }
      }
      this.toolsMetadataCache.set(serverId, metadataMap);

      return result;
    } catch (error) {
      if (this.isMethodUnavailableError(error, "tools/list")) {
        this.toolsMetadataCache.set(serverId, new Map());
        return { tools: [] } as Awaited<ReturnType<Client["listTools"]>>;
      }
      throw error;
    }
  }

  async getTools(serverIds?: string[]): Promise<ListToolsResult> {
    const targetServerIds =
      serverIds && serverIds.length > 0 ? serverIds : this.listServers();

    const toolLists = await Promise.all(
      targetServerIds.map(async (serverId) => {
        await this.ensureConnected(serverId);
        const client = this.getClientById(serverId);
        const result = await client.listTools(
          undefined,
          this.withTimeout(serverId),
        );

        const metadataMap = new Map<string, any>();
        for (const tool of result.tools) {
          if (tool._meta) {
            metadataMap.set(tool.name, tool._meta);
          }
        }
        this.toolsMetadataCache.set(serverId, metadataMap);

        return result.tools;
      }),
    );
    return { tools: toolLists.flat() } as ListToolsResult;
  }

  getAllToolsMetadata(serverId: string): Record<string, Record<string, any>> {
    const metadataMap = this.toolsMetadataCache.get(serverId);
    return metadataMap ? Object.fromEntries(metadataMap) : {};
  }

  pingServer(serverId: string, options?: RequestOptions) {
    const client = this.getClientById(serverId);
    try {
      client.ping(options);
    } catch (error) {
      throw new Error(
        `Failed to ping MCP server "${serverId}": ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async getToolsForAiSdk(
    serverIds?: string[] | string,
    options: { schemas?: ToolSchemaOverrides | "automatic" } = {},
  ): Promise<ToolSet> {
    const ids = Array.isArray(serverIds)
      ? serverIds
      : serverIds
        ? [serverIds]
        : this.listServers();

    const loadForServer = async (id: string): Promise<ToolSet> => {
      await this.ensureConnected(id);
      const listToolsResult = await this.listTools(id);
      return convertMCPToolsToVercelTools(listToolsResult, {
        schemas: options.schemas,
        callTool: async ({ name, args, options: callOptions }) => {
          const requestOptions = callOptions?.abortSignal
            ? { signal: callOptions.abortSignal }
            : undefined;
          const result = await this.executeTool(
            id,
            name,
            (args ?? {}) as ExecuteToolArguments,
            requestOptions,
          );
          return CallToolResultSchema.parse(result);
        },
      });
    };

    const perServerTools = await Promise.all(
      ids.map(async (id) => {
        try {
          const tools = await loadForServer(id);
          // Attach server id metadata to each tool object for downstream extraction
          for (const [name, tool] of Object.entries(tools)) {
            (tool as any)._serverId = id;
          }
          return tools;
        } catch (error) {
          if (this.isMethodUnavailableError(error, "tools/list")) {
            return {} as ToolSet;
          }
          throw error;
        }
      }),
    );

    // Flatten into a single ToolSet (last-in wins for name collisions)
    const flattened: ToolSet = {};
    for (const toolset of perServerTools) {
      for (const [name, tool] of Object.entries(toolset)) {
        flattened[name] = tool;
      }
    }

    return flattened;
  }

  async executeTool(
    serverId: string,
    toolName: string,
    args: ExecuteToolArguments = {},
    options?: CallToolOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);

    // Merge global progress handler with any provided options
    const mergedOptions = this.withTimeout(serverId, options);
    if (!mergedOptions.onprogress) {
      mergedOptions.onprogress = () => {
        // register an empty on progress so that the client will send
        // progress notifications...the notifications will be sent through the
        // rpc logger
      };
    }

    return client.callTool(
      {
        name: toolName,
        arguments: args,
      },
      CallToolResultSchema,
      mergedOptions,
    );
  }

  async setLoggingLevel(serverId: string, level: LoggingLevel = "debug") {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    try {
      await client.setLoggingLevel(level);
    } catch (error) {
      throw new Error(
        `Failed to set logging level for MCP server "${serverId}": ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }

  async listResources(
    serverId: string,
    params?: ListResourcesParams,
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    try {
      return await client.listResources(
        params,
        this.withTimeout(serverId, options),
      );
    } catch (error) {
      if (this.isMethodUnavailableError(error, "resources/list")) {
        return {
          resources: [],
        } as Awaited<ReturnType<Client["listResources"]>>;
      }
      throw error;
    }
  }

  async readResource(
    serverId: string,
    params: ReadResourceParams,
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    // Merge global progress handler with any provided options
    const mergedOptions = this.withTimeout(serverId, options);
    if (!mergedOptions.onprogress) {
      mergedOptions.onprogress = () => {
        // register an empty on progress so that the client will send
        // progress notifications...the notifications will be sent through the
        // rpc logger
      };
    }
    return client.readResource(params, mergedOptions);
  }

  async subscribeResource(
    serverId: string,
    params: SubscribeResourceParams,
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.subscribeResource(
      params,
      this.withTimeout(serverId, options),
    );
  }

  async unsubscribeResource(
    serverId: string,
    params: UnsubscribeResourceParams,
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.unsubscribeResource(
      params,
      this.withTimeout(serverId, options),
    );
  }

  async listResourceTemplates(
    serverId: string,
    params?: ListResourceTemplatesParams,
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    return client.listResourceTemplates(
      params,
      this.withTimeout(serverId, options),
    );
  }

  async listPrompts(
    serverId: string,
    params?: ListPromptsParams,
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    try {
      return await client.listPrompts(
        params,
        this.withTimeout(serverId, options),
      );
    } catch (error) {
      if (this.isMethodUnavailableError(error, "prompts/list")) {
        return {
          prompts: [],
        } as Awaited<ReturnType<Client["listPrompts"]>>;
      }
      throw error;
    }
  }

  async getPrompt(
    serverId: string,
    params: GetPromptParams,
    options?: ClientRequestOptions,
  ) {
    await this.ensureConnected(serverId);
    const client = this.getClientById(serverId);
    // Merge global progress handler with any provided options
    const mergedOptions = this.withTimeout(serverId, options);
    if (!mergedOptions.onprogress) {
      mergedOptions.onprogress = () => {
        // register an empty on progress so that the client will send
        // progress notifications...the notifications will be sent through the
        // rpc logger
      };
    }
    return client.getPrompt(params, mergedOptions);
  }

  getSessionIdByServer(serverId: string): string | undefined {
    const state = this.clientStates.get(serverId);
    if (!state?.transport) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }
    if (state.transport instanceof StreamableHTTPClientTransport) {
      return state.transport.sessionId;
    }
    throw new Error(
      `Server "${serverId}" must be Streamable HTTP to get the session ID.`,
    );
  }

  addNotificationHandler(
    serverId: string,
    schema: NotificationSchema,
    handler: NotificationHandler,
  ): void {
    const serverHandlers = this.notificationHandlers.get(serverId) ?? new Map();
    const handlersForSchema =
      serverHandlers.get(schema) ?? new Set<NotificationHandler>();
    handlersForSchema.add(handler);
    serverHandlers.set(schema, handlersForSchema);
    this.notificationHandlers.set(serverId, serverHandlers);

    const client = this.clientStates.get(serverId)?.client;
    if (client) {
      client.setNotificationHandler(
        schema,
        this.createNotificationDispatcher(serverId, schema),
      );
    }
  }

  onResourceListChanged(serverId: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverId,
      ResourceListChangedNotificationSchema,
      handler,
    );
  }

  onResourceUpdated(serverId: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverId,
      ResourceUpdatedNotificationSchema,
      handler,
    );
  }

  onPromptListChanged(serverId: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverId,
      PromptListChangedNotificationSchema,
      handler,
    );
  }

  getClient(serverId: string): Client | undefined {
    return this.clientStates.get(serverId)?.client;
  }

  setElicitationHandler(serverId: string, handler: ElicitationHandler): void {
    if (!this.clientStates.has(serverId)) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }

    this.elicitationHandlers.set(serverId, handler);

    const client = this.clientStates.get(serverId)?.client;
    if (client) {
      this.applyElicitationHandler(serverId, client);
    }
  }

  clearElicitationHandler(serverId: string): void {
    this.elicitationHandlers.delete(serverId);
    const client = this.clientStates.get(serverId)?.client;
    if (client) {
      client.removeRequestHandler("elicitation/create");
    }
  }

  // Global elicitation callback API (no serverId required)
  setElicitationCallback(
    callback: (request: {
      requestId: string;
      message: string;
      schema: unknown;
    }) => Promise<ElicitResult> | ElicitResult,
  ): void {
    this.elicitationCallback = callback;
    // Apply to all connected clients that don't have a server-specific handler
    for (const [serverId, state] of this.clientStates.entries()) {
      const client = state.client;
      if (!client) continue;
      if (this.elicitationHandlers.has(serverId)) {
        // Respect server-specific handler
        this.applyElicitationHandler(serverId, client);
      } else {
        this.applyElicitationHandler(serverId, client);
      }
    }
  }

  clearElicitationCallback(): void {
    this.elicitationCallback = undefined;
    // Reconfigure clients: keep server-specific handlers, otherwise remove
    for (const [serverId, state] of this.clientStates.entries()) {
      const client = state.client;
      if (!client) continue;
      if (this.elicitationHandlers.has(serverId)) {
        this.applyElicitationHandler(serverId, client);
      } else {
        client.removeRequestHandler("elicitation/create");
      }
    }
  }

  // Expose the pending elicitation map so callers can add resolvers
  getPendingElicitations(): Map<
    string,
    {
      resolve: (value: ElicitResult) => void;
      reject: (error: unknown) => void;
    }
  > {
    return this.pendingElicitations;
  }

  // Helper to resolve a pending elicitation from outside
  respondToElicitation(requestId: string, response: ElicitResult): boolean {
    const pending = this.pendingElicitations.get(requestId);
    if (!pending) return false;
    try {
      pending.resolve(response);
      return true;
    } finally {
      this.pendingElicitations.delete(requestId);
    }
  }

  private async connectViaStdio(
    serverId: string,
    client: Client,
    config: StdioServerConfig,
    timeout: number,
  ): Promise<Transport> {
    const underlying = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    });
    const wrapped = this.wrapTransportForLogging(serverId, config, underlying);
    await client.connect(wrapped, { timeout });
    return underlying;
  }

  private async connectViaHttp(
    serverId: string,
    client: Client,
    config: HttpServerConfig,
    timeout: number,
  ): Promise<Transport> {
    const preferSSE = config.preferSSE ?? config.url.pathname.endsWith("/sse");
    let streamableError: unknown;

    if (!preferSSE) {
      const streamableTransport = new StreamableHTTPClientTransport(
        config.url,
        {
          requestInit: config.requestInit,
          reconnectionOptions: config.reconnectionOptions,
          authProvider: config.authProvider,
          sessionId: config.sessionId,
        },
      );

      try {
        const wrapped = this.wrapTransportForLogging(
          serverId,
          config,
          streamableTransport,
        );
        await client.connect(wrapped, {
          timeout: Math.min(timeout, 3000),
        });
        return streamableTransport;
      } catch (error) {
        streamableError = error;
        await this.safeCloseTransport(streamableTransport);
      }
    }

    const sseTransport = new SSEClientTransport(config.url, {
      requestInit: config.requestInit,
      eventSourceInit: config.eventSourceInit,
      authProvider: config.authProvider,
    });

    try {
      const wrapped = this.wrapTransportForLogging(
        serverId,
        config,
        sseTransport,
      );
      await client.connect(wrapped, { timeout });
      return sseTransport;
    } catch (error) {
      await this.safeCloseTransport(sseTransport);
      const streamableMessage = streamableError
        ? ` Streamable HTTP error: ${this.formatError(streamableError)}.`
        : "";
      throw new Error(
        `Failed to connect to MCP server "${serverId}" using HTTP transports.${streamableMessage} SSE error: ${this.formatError(error)}.`,
      );
    }
  }

  private async safeCloseTransport(transport: Transport): Promise<void> {
    try {
      await transport.close();
    } catch {
      // Ignore close errors during cleanup.
    }
  }

  private applyNotificationHandlers(serverId: string, client: Client): void {
    const serverHandlers = this.notificationHandlers.get(serverId);
    if (!serverHandlers) {
      return;
    }

    for (const [schema] of serverHandlers) {
      client.setNotificationHandler(
        schema,
        this.createNotificationDispatcher(serverId, schema),
      );
    }
  }

  private createNotificationDispatcher(
    serverId: string,
    schema: NotificationSchema,
  ): NotificationHandler {
    return (notification) => {
      const serverHandlers = this.notificationHandlers.get(serverId);
      const handlersForSchema = serverHandlers?.get(schema);
      if (!handlersForSchema || handlersForSchema.size === 0) {
        return;
      }
      for (const handler of handlersForSchema) {
        try {
          handler(notification);
        } catch {
          // Swallow individual handler errors to avoid breaking other listeners.
        }
      }
    };
  }

  private applyElicitationHandler(serverId: string, client: Client): void {
    const serverSpecific = this.elicitationHandlers.get(serverId);
    if (serverSpecific) {
      client.setRequestHandler(ElicitRequestSchema, async (request) =>
        serverSpecific(request.params),
      );
      return;
    }

    if (this.elicitationCallback) {
      client.setRequestHandler(ElicitRequestSchema, async (request) => {
        const reqId = `elicit_${Date.now()}_${Math.random()
          .toString(36)
          .slice(2, 9)}`;
        return await this.elicitationCallback!({
          requestId: reqId,
          message: (request.params as any)?.message,
          schema:
            (request.params as any)?.requestedSchema ??
            (request.params as any)?.schema,
        });
      });
      return;
    }
  }

  private async ensureConnected(serverId: string): Promise<void> {
    const state = this.clientStates.get(serverId);
    if (state?.client) {
      return;
    }

    if (!state) {
      throw new Error(`Unknown MCP server "${serverId}".`);
    }
    if (state.promise) {
      await state.promise;
      return;
    }
    await this.connectToServer(serverId, state.config);
  }

  private resetState(serverId: string): void {
    this.clientStates.delete(serverId);
    this.toolsMetadataCache.delete(serverId);
  }

  private resolveConnectionStatus(
    state: ManagedClientState | undefined,
  ): MCPConnectionStatus {
    if (!state) {
      return "disconnected";
    }
    if (state.client) {
      return "connected";
    }
    if (state.promise) {
      return "connecting";
    }
    return "disconnected";
  }

  private withTimeout(
    serverId: string,
    options?: RequestOptions,
  ): RequestOptions {
    const state = this.clientStates.get(serverId);
    const timeout =
      state?.timeout ??
      (state ? this.getTimeout(state.config) : this.defaultTimeout);

    if (!options) {
      return { timeout };
    }

    if (options.timeout === undefined) {
      return { ...options, timeout };
    }

    return options;
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

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  // Returns a transport that logs JSON-RPC traffic if enabled for this server
  private wrapTransportForLogging(
    serverId: string,
    config: MCPServerConfig,
    transport: Transport,
  ): Transport {
    const logger = this.resolveRpcLogger(serverId, config);
    if (!logger) return transport;
    const log: (event: {
      direction: "send" | "receive";
      message: unknown;
      serverId: string;
    }) => void = logger;

    // Wrapper that proxies to the underlying transport while emitting logs
    const self = this;
    class LoggingTransport implements Transport {
      onclose?: () => void;
      onerror?: (error: Error) => void;
      onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
      constructor(private readonly inner: Transport) {
        this.inner.onmessage = (
          message: JSONRPCMessage,
          extra?: MessageExtraInfo,
        ) => {
          try {
            log({ direction: "receive", message, serverId });
          } catch {
            // ignore logger errors
          }
          this.onmessage?.(message, extra);
        };
        this.inner.onclose = () => {
          this.onclose?.();
        };
        this.inner.onerror = (error: Error) => {
          this.onerror?.(error);
        };
      }
      async start(): Promise<void> {
        if (typeof (this.inner as any).start === "function") {
          await (this.inner as any).start();
        }
      }
      async send(
        message: JSONRPCMessage,
        options?: TransportSendOptions,
      ): Promise<void> {
        try {
          log({ direction: "send", message, serverId });
        } catch {
          // ignore logger errors
        }
        await this.inner.send(message as any, options as any);
      }
      async close(): Promise<void> {
        await this.inner.close();
      }
      get sessionId(): string | undefined {
        return (this.inner as any).sessionId;
      }
      setProtocolVersion?(version: string): void {
        if (typeof this.inner.setProtocolVersion === "function") {
          this.inner.setProtocolVersion(version);
        }
      }
    }

    return new LoggingTransport(transport);
  }

  private resolveRpcLogger(
    serverId: string,
    config: MCPServerConfig,
  ):
    | ((event: {
        direction: "send" | "receive";
        message: unknown;
        serverId: string;
      }) => void)
    | undefined {
    if (config.rpcLogger) return config.rpcLogger;
    if (config.logJsonRpc || this.defaultLogJsonRpc) {
      return ({ direction, message, serverId: id }) => {
        let printable: string;
        try {
          printable =
            typeof message === "string" ? message : JSON.stringify(message);
        } catch {
          printable = String(message);
        }
        // eslint-disable-next-line no-console
        console.debug(`[MCP:${id}] ${direction.toUpperCase()} ${printable}`);
      };
    }
    if (this.defaultRpcLogger) return this.defaultRpcLogger;
    return undefined;
  }

  private isMethodUnavailableError(error: unknown, method: string): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    const methodTokens = new Set<string>();
    const pushToken = (token: string) => {
      if (token) {
        methodTokens.add(token.toLowerCase());
      }
    };

    pushToken(method);
    for (const part of method.split(/[\/:._-]/)) {
      pushToken(part);
    }
    const indicators = [
      "method not found",
      "not implemented",
      "unsupported",
      "does not support",
      "unimplemented",
    ];
    const indicatorMatch = indicators.some((indicator) =>
      message.includes(indicator),
    );
    if (!indicatorMatch) {
      return false;
    }

    if (Array.from(methodTokens).some((token) => message.includes(token))) {
      return true;
    }

    return true;
  }

  private getTimeout(config: MCPServerConfig): number {
    return config.timeout ?? this.defaultTimeout;
  }

  private isStdioConfig(config: MCPServerConfig): config is StdioServerConfig {
    return "command" in config;
  }

  private getClientById(serverId: string): Client {
    const state = this.clientStates.get(serverId);
    if (!state?.client) {
      throw new Error(`MCP server "${serverId}" is not connected.`);
    }
    return state.client;
  }
}

export type MCPPromptListResult = Awaited<
  ReturnType<MCPClientManager["listPrompts"]>
>;
export type MCPPrompt = MCPPromptListResult["prompts"][number];
export type MCPGetPromptResult = Awaited<
  ReturnType<MCPClientManager["getPrompt"]>
>;
export type MCPResourceListResult = Awaited<
  ReturnType<MCPClientManager["listResources"]>
>;
export type MCPResource = MCPResourceListResult["resources"][number];
export type MCPReadResourceResult = Awaited<
  ReturnType<MCPClientManager["readResource"]>
>;
export type MCPResourceTemplateListResult = Awaited<
  ReturnType<MCPClientManager["listResourceTemplates"]>
>;
export type MCPResourceTemplate =
  MCPResourceTemplateListResult["resourceTemplates"][number];
export type MCPServerSummary = ServerSummary;
export type MCPConvertedToolSet<
  SCHEMAS extends ToolSchemaOverrides | "automatic",
> = ConvertedToolSet<SCHEMAS>;
export type MCPToolSchemaOverrides = ToolSchemaOverrides;
