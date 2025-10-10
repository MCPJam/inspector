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
} from "@modelcontextprotocol/sdk/types.js";
type ClientCapabilityOptions = NonNullable<ClientOptions["capabilities"]>;

type BaseServerConfig = {
  capabilities?: ClientCapabilityOptions;
  timeout?: number;
  version?: string;
  onError?: (error: unknown) => void;
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
  private readonly defaultClientVersion: string;
  private readonly defaultCapabilities: ClientCapabilityOptions;
  private readonly defaultTimeout: number;

  constructor(
    servers: MCPClientManagerConfig = {},
    options: {
      defaultClientVersion?: string;
      defaultCapabilities?: ClientCapabilityOptions;
      defaultTimeout?: number;
    } = {},
  ) {
    this.defaultClientVersion = options.defaultClientVersion ?? "1.0.0";
    this.defaultCapabilities = { ...(options.defaultCapabilities ?? {}) };
    this.defaultTimeout =
      options.defaultTimeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;

    for (const [name, config] of Object.entries(servers)) {
      void this.connectToServer(name, config);
    }
  }

  listServers(): string[] {
    return Array.from(this.clientStates.keys());
  }

  hasServer(serverName: string): boolean {
    const normalizedServerName = this.normalizeName(serverName);
    return this.clientStates.has(normalizedServerName);
  }

  async connectToServer(
    serverName: string,
    config: MCPServerConfig,
  ): Promise<Client> {
    const normalizedServerName = this.normalizeName(serverName);
    if(this.clientStates.has(normalizedServerName)) {
      throw new Error(`MCP server "${normalizedServerName}" is already connected.`);
    }
    const timeout = this.getTimeout(config);
    const state = this.clientStates.get(normalizedServerName) ?? {
      config,
      timeout,
    };
    // Update config/timeout on every call
    state.config = config;
    state.timeout = timeout;
    // If already connected, return the client
    if (state.client) {
      this.clientStates.set(normalizedServerName, state);
      return state.client;
    }
    // If connection is in-flight, reuse the promise
    if (state.promise) {
      this.clientStates.set(normalizedServerName, state);
      return state.promise;
    }

    const connectionPromise = (async () => {
      const client = new Client(
        {
          name: normalizedServerName,
          version: config.version ?? this.defaultClientVersion,
        },
        {
          capabilities: this.buildCapabilities(config),
        },
      );

      this.applyNotificationHandlers(normalizedServerName, client);
      this.applyElicitationHandler(normalizedServerName, client);

      if (config.onError) {
        client.onerror = (error) => {
          config.onError?.(error);
        };
      }

      client.onclose = () => {
        this.resetState(normalizedServerName);
      };

      let transport: Transport;
      if (this.isStdioConfig(config)) {
        transport = await this.connectViaStdio(client, config, timeout);
      } else {
        transport = await this.connectViaHttp(
          normalizedServerName,
          client,
          config,
          timeout,
        );
      }

      state.client = client;
      state.transport = transport;
      // clear pending
      state.promise = undefined;
      this.clientStates.set(normalizedServerName, state);

      return client;
    })().catch((error) => {
      // Clear pending but keep config so the server remains registered
      state.promise = undefined;
      state.client = undefined;
      state.transport = undefined;
      this.clientStates.set(normalizedServerName, state);
      throw error;
    });

    state.promise = connectionPromise;
    this.clientStates.set(normalizedServerName, state);
    return connectionPromise;
  }

  async disconnectServer(serverName: string): Promise<void> {
    const normalizedServerName = this.normalizeName(serverName);
    const client = this.getClientByName(normalizedServerName);
    try {
      await client.close();
    } finally {
      if (client.transport) {
        await this.safeCloseTransport(client.transport);
      }
      this.resetState(normalizedServerName);
    }
  }

  async disconnectAllServers(): Promise<void> {
    const serverNames = this.listServers();
    await Promise.all(serverNames.map((name) => this.disconnectServer(name)));

    for (const serverName of serverNames) {
      const normalizedServerName = this.normalizeName(serverName);
      this.resetState(normalizedServerName);
      this.notificationHandlers.delete(normalizedServerName);
      this.elicitationHandlers.delete(normalizedServerName);
    }
  }

  async listTools(
    serverName: string,
    params?: Parameters<Client["listTools"]>[0],
    options?: ClientRequestOptions,
  ) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.listTools(
      params,
      this.withTimeout(normalizedServerName, options),
    );
  }

  async getTools(names?: string[]): Promise<ListToolsResult> {
    const targetNames =
      names && names.length > 0
        ? names.map((name) => this.normalizeName(name))
        : this.listServers();
    const uniqueNames = Array.from(new Set(targetNames));

    const toolLists = await Promise.all(
      uniqueNames.map(async (serverName) => {
        await this.ensureConnected(serverName);
        const client = this.getClientByName(serverName);
        const result = await client.listTools(
          undefined,
          this.withTimeout(serverName),
        );
        return result.tools;
      }),
    );

    return { tools: toolLists.flat() };
  }

  async executeTool(
    serverName: string,
    toolName: string,
    args: ExecuteToolArguments = {},
    options?: CallToolOptions,
  ) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.callTool(
      {
        name: toolName,
        arguments: args,
      },
      CallToolResultSchema,
      this.withTimeout(normalizedServerName, options),
    );
  }

  async listResources(
    serverName: string,
    params?: ListResourcesParams,
    options?: ClientRequestOptions,
  ) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.listResources(
      params,
      this.withTimeout(normalizedServerName, options),
    );
  }

  async readResource(
    serverName: string,
    params: ReadResourceParams,
    options?: ClientRequestOptions,
  ) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.readResource(
      params,
      this.withTimeout(normalizedServerName, options),
    );
  }

  async subscribeResource(
    serverName: string,
    params: SubscribeResourceParams,
    options?: ClientRequestOptions,
  ) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.subscribeResource(
      params,
      this.withTimeout(normalizedServerName, options),
    );
  }

  async unsubscribeResource(
    serverName: string,
    params: UnsubscribeResourceParams,
    options?: ClientRequestOptions,
  ) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.unsubscribeResource(
      params,
      this.withTimeout(normalizedServerName, options),
    );
  }

  async listResourceTemplates(
    serverName: string,
    params?: ListResourceTemplatesParams,
    options?: ClientRequestOptions,
  ) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.listResourceTemplates(
      params,
      this.withTimeout(normalizedServerName, options),
    );
  }

  async listPrompts(
    serverName: string,
    params?: ListPromptsParams,
    options?: ClientRequestOptions,
  ) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.listPrompts(
      params,
      this.withTimeout(normalizedServerName, options),
    );
  }

  async getPrompt(
    serverName: string,
    params: GetPromptParams,
    options?: ClientRequestOptions,
  ) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.getPrompt(
      params,
      this.withTimeout(normalizedServerName, options),
    );
  }

  getSessionIdByServer(serverName: string): string | undefined {
    const state = this.clientStates.get(this.normalizeName(serverName));
    if (!state?.transport) {
      throw new Error(`Unknown MCP server "${serverName}".`);
    }
    if (state.transport instanceof StreamableHTTPClientTransport) {
      return state.transport.sessionId;
    }
    throw new Error(
      `Server "${serverName}" must be Streamable HTTP to get the session ID.`,
    );
  }

  addNotificationHandler(
    serverName: string,
    schema: NotificationSchema,
    handler: NotificationHandler,
  ): void {
    const normalizedServerName = this.normalizeName(serverName);
    const serverHandlers =
      this.notificationHandlers.get(normalizedServerName) ?? new Map();
    const handlersForSchema =
      serverHandlers.get(schema) ?? new Set<NotificationHandler>();
    handlersForSchema.add(handler);
    serverHandlers.set(schema, handlersForSchema);
    this.notificationHandlers.set(normalizedServerName, serverHandlers);

    const client = this.clientStates.get(normalizedServerName)?.client;
    if (client) {
      client.setNotificationHandler(
        schema,
        this.createNotificationDispatcher(normalizedServerName, schema),
      );
    }
  }

  onResourceListChanged(
    serverName: string,
    handler: NotificationHandler,
  ): void {
    this.addNotificationHandler(
      serverName,
      ResourceListChangedNotificationSchema,
      handler,
    );
  }

  onResourceUpdated(serverName: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverName,
      ResourceUpdatedNotificationSchema,
      handler,
    );
  }

  onPromptListChanged(serverName: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverName,
      PromptListChangedNotificationSchema,
      handler,
    );
  }

  getClient(serverName: string): Client | undefined {
    return this.clientStates.get(this.normalizeName(serverName))?.client;
  }

  setElicitationHandler(serverName: string, handler: ElicitationHandler): void {
    const normalizedServerName = this.normalizeName(serverName);
    if (!this.clientStates.has(normalizedServerName)) {
      throw new Error(`Unknown MCP server "${normalizedServerName}".`);
    }

    this.elicitationHandlers.set(normalizedServerName, handler);

    const client = this.clientStates.get(normalizedServerName)?.client;
    if (client) {
      this.applyElicitationHandler(normalizedServerName, client);
    }
  }

  clearElicitationHandler(serverName: string): void {
    const normalizedServerName = this.normalizeName(serverName);
    this.elicitationHandlers.delete(normalizedServerName);
    const client = this.clientStates.get(normalizedServerName)?.client;
    if (client) {
      client.removeRequestHandler("elicitation/create");
    }
  }

  private async connectViaStdio(
    client: Client,
    config: StdioServerConfig,
    timeout: number,
  ): Promise<Transport> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...getDefaultEnvironment(), ...(config.env ?? {}) },
    });
    await client.connect(transport, { timeout });
    return transport;
  }

  private async connectViaHttp(
    serverName: string,
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
        await client.connect(streamableTransport, {
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
      await client.connect(sseTransport, { timeout });
      return sseTransport;
    } catch (error) {
      await this.safeCloseTransport(sseTransport);
      const streamableMessage = streamableError
        ? ` Streamable HTTP error: ${this.formatError(streamableError)}.`
        : "";
      throw new Error(
        `Failed to connect to MCP server "${serverName}" using HTTP transports.${streamableMessage} SSE error: ${this.formatError(error)}.`,
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

  private applyNotificationHandlers(serverName: string, client: Client): void {
    const serverHandlers = this.notificationHandlers.get(serverName);
    if (!serverHandlers) {
      return;
    }

    for (const [schema] of serverHandlers) {
      client.setNotificationHandler(
        schema,
        this.createNotificationDispatcher(serverName, schema),
      );
    }
  }

  private createNotificationDispatcher(
    serverName: string,
    schema: NotificationSchema,
  ): NotificationHandler {
    return (notification) => {
      const serverHandlers = this.notificationHandlers.get(serverName);
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

  private applyElicitationHandler(serverName: string, client: Client): void {
    const handler = this.elicitationHandlers.get(serverName);
    if (!handler) {
      return;
    }

    client.setRequestHandler(ElicitRequestSchema, async (request) =>
      handler(request.params),
    );
  }

  private async ensureConnected(serverName: string): Promise<void> {
    const normalizedServerName = this.normalizeName(serverName);
    const state = this.clientStates.get(normalizedServerName);
    if (state?.client) {
      return;
    }

    if (!state) {
      throw new Error(`Unknown MCP server "${normalizedServerName}".`);
    }
    if (state.promise) {
      await state.promise;
      return;
    }
    await this.connectToServer(normalizedServerName, state.config);
  }

  private resetState(serverName: string): void {
    const normalizedServerName = this.normalizeName(serverName);
    this.clientStates.delete(normalizedServerName);
  }

  private withTimeout(
    serverName: string,
    options?: RequestOptions,
  ): RequestOptions {
    const normalizedServerName = this.normalizeName(serverName);
    const state = this.clientStates.get(normalizedServerName);
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

  private getTimeout(config: MCPServerConfig): number {
    return config.timeout ?? this.defaultTimeout;
  }

  private isStdioConfig(config: MCPServerConfig): config is StdioServerConfig {
    return "command" in config;
  }

  private normalizeName(serverName: string): string {
    const normalized = serverName.trim();
    if (!normalized) {
      throw new Error("Server name must be a non-empty string.");
    }
    return normalized;
  }

  private getClientByName(serverName: string): Client {
    const normalizedServerName = this.normalizeName(serverName);
    const state = this.clientStates.get(normalizedServerName);
    if (!state?.client) {
      throw new Error(`MCP server "${normalizedServerName}" is not connected.`);
    }
    return state.client;
  }
}
