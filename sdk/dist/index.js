import {
  __export
} from "./chunk-PZ5AY32C.js";

// mcp-client-manager/index.js
var mcp_client_manager_exports = {};
__export(mcp_client_manager_exports, {
  MCPClientManager: () => MCPClientManager
});
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  CallToolResultSchema,
  ElicitRequestSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema
} from "@modelcontextprotocol/sdk/types.js";
var MCPClientManager = class {
  constructor(servers = {}, options = {}) {
    this.clientStates = /* @__PURE__ */ new Map();
    this.pendingConnections = /* @__PURE__ */ new Map();
    this.serverConfigs = /* @__PURE__ */ new Map();
    this.notificationHandlers = /* @__PURE__ */ new Map();
    this.elicitationHandlers = /* @__PURE__ */ new Map();
    var _a, _b, _c;
    this.defaultClientVersion = (_a = options.defaultClientVersion) != null ? _a : "1.0.0";
    this.defaultCapabilities = {
      ...(_b = options.defaultCapabilities) != null ? _b : {}
    };
    this.defaultTimeout = (_c = options.defaultTimeout) != null ? _c : DEFAULT_REQUEST_TIMEOUT_MSEC;
    for (const [name, config] of Object.entries(servers)) {
      void this.connectToServer(name, config);
    }
  }
  listServers() {
    return Array.from(this.serverConfigs.keys());
  }
  hasServer(name) {
    const serverName = this.normalizeName(name);
    return this.serverConfigs.has(serverName);
  }
  async connectToServer(name, config) {
    const serverName = this.normalizeName(name);
    this.serverConfigs.set(serverName, config);
    const timeout = this.getTimeout(config);
    const existingState = this.clientStates.get(serverName);
    if (existingState) {
      existingState.config = config;
      existingState.timeout = timeout;
      this.clientStates.set(serverName, existingState);
      return existingState.client;
    }
    const pendingState = this.pendingConnections.get(serverName);
    if (pendingState) {
      pendingState.config = config;
      pendingState.timeout = timeout;
      return pendingState.promise;
    }
    const connectionPromise = (async () => {
      var _a;
      const client = new Client(
        {
          name: serverName,
          version: (_a = config.version) != null ? _a : this.defaultClientVersion
        },
        {
          capabilities: this.buildCapabilities(config)
        }
      );
      this.applyNotificationHandlers(serverName, client);
      this.applyElicitationHandler(serverName, client);
      if (config.onError) {
        client.onerror = (error) => {
          var _a2;
          (_a2 = config.onError) == null ? void 0 : _a2.call(config, error);
        };
      }
      client.onclose = () => {
        this.resetState(serverName, { preserveConfig: true });
      };
      let transport;
      if (this.isStdioConfig(config)) {
        transport = await this.connectViaStdio(client, config, timeout);
      } else {
        transport = await this.connectViaHttp(
          serverName,
          client,
          config,
          timeout
        );
      }
      const managedState = {
        config,
        client,
        transport,
        timeout
      };
      this.clientStates.set(serverName, managedState);
      this.pendingConnections.delete(serverName);
      return client;
    })().catch((error) => {
      this.pendingConnections.delete(serverName);
      this.clientStates.delete(serverName);
      throw error;
    });
    this.pendingConnections.set(serverName, {
      config,
      timeout,
      promise: connectionPromise
    });
    return connectionPromise;
  }
  async disconnectServer(name) {
    const serverName = this.normalizeName(name);
    const pending = this.pendingConnections.get(serverName);
    if (pending) {
      try {
        await pending.promise;
      } catch {
      }
    }
    const state = this.clientStates.get(serverName);
    if (!state) {
      this.resetState(serverName, { preserveConfig: true });
      return;
    }
    try {
      await state.client.close();
    } finally {
      await this.safeCloseTransport(state.transport);
      this.resetState(serverName, { preserveConfig: true });
    }
  }
  async disconnectAllServers() {
    const serverNames = this.listServers();
    await Promise.all(serverNames.map((name) => this.disconnectServer(name)));
    for (const name of serverNames) {
      const serverName = this.normalizeName(name);
      this.resetState(serverName, { preserveConfig: false });
      this.notificationHandlers.delete(serverName);
      this.elicitationHandlers.delete(serverName);
    }
  }
  async listTools(name, params, options) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.listTools(params, this.withTimeout(serverName, options));
  }
  async getTools(names) {
    const targetNames = names && names.length > 0 ? names.map((name) => this.normalizeName(name)) : this.listServers();
    const uniqueNames = Array.from(new Set(targetNames));
    const toolLists = await Promise.all(
      uniqueNames.map(async (serverName) => {
        await this.ensureConnected(serverName);
        const client = this.getClientByName(serverName);
        const result = await client.listTools(
          void 0,
          this.withTimeout(serverName)
        );
        return result.tools;
      })
    );
    return { tools: toolLists.flat() };
  }
  async executeTool(name, toolName, args = {}, options) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.callTool(
      {
        name: toolName,
        arguments: args
      },
      CallToolResultSchema,
      this.withTimeout(serverName, options)
    );
  }
  async listResources(name, params, options) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.listResources(params, this.withTimeout(serverName, options));
  }
  async readResource(name, params, options) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.readResource(params, this.withTimeout(serverName, options));
  }
  async subscribeResource(name, params, options) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.subscribeResource(
      params,
      this.withTimeout(serverName, options)
    );
  }
  async unsubscribeResource(name, params, options) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.unsubscribeResource(
      params,
      this.withTimeout(serverName, options)
    );
  }
  async listResourceTemplates(name, params, options) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.listResourceTemplates(
      params,
      this.withTimeout(serverName, options)
    );
  }
  async listPrompts(name, params, options) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.listPrompts(params, this.withTimeout(serverName, options));
  }
  async getPrompt(name, params, options) {
    const serverName = this.normalizeName(name);
    await this.ensureConnected(serverName);
    const client = this.getClientByName(serverName);
    return client.getPrompt(params, this.withTimeout(serverName, options));
  }
  getSessionIdByServer(name) {
    const state = this.clientStates.get(this.normalizeName(name));
    if (!(state == null ? void 0 : state.transport)) {
      throw new Error(`Unknown MCP server "${name}".`);
    }
    if (state.transport instanceof StreamableHTTPClientTransport) {
      return state.transport.sessionId;
    }
    throw new Error(
      `Server "${name}" must be Streamable HTTP to get the session ID.`
    );
  }
  addNotificationHandler(name, schema, handler) {
    var _a, _b;
    const serverName = this.normalizeName(name);
    const handlers = (_a = this.notificationHandlers.get(serverName)) != null ? _a : [];
    handlers.push({ schema, handler });
    this.notificationHandlers.set(serverName, handlers);
    const client = (_b = this.clientStates.get(serverName)) == null ? void 0 : _b.client;
    if (client) {
      client.setNotificationHandler(schema, handler);
    }
  }
  onResourceListChanged(name, handler) {
    this.addNotificationHandler(
      name,
      ResourceListChangedNotificationSchema,
      handler
    );
  }
  onResourceUpdated(name, handler) {
    this.addNotificationHandler(
      name,
      ResourceUpdatedNotificationSchema,
      handler
    );
  }
  onPromptListChanged(name, handler) {
    this.addNotificationHandler(
      name,
      PromptListChangedNotificationSchema,
      handler
    );
  }
  getClient(name) {
    var _a;
    return (_a = this.clientStates.get(this.normalizeName(name))) == null ? void 0 : _a.client;
  }
  setElicitationHandler(name, handler) {
    var _a;
    const serverName = this.normalizeName(name);
    if (!this.serverConfigs.has(serverName)) {
      throw new Error(`Unknown MCP server "${serverName}".`);
    }
    this.elicitationHandlers.set(serverName, handler);
    const client = (_a = this.clientStates.get(serverName)) == null ? void 0 : _a.client;
    if (client) {
      this.applyElicitationHandler(serverName, client);
    }
  }
  clearElicitationHandler(name) {
    var _a;
    const serverName = this.normalizeName(name);
    this.elicitationHandlers.delete(serverName);
    const client = (_a = this.clientStates.get(serverName)) == null ? void 0 : _a.client;
    if (client) {
      client.removeRequestHandler("elicitation/create");
    }
  }
  async connectViaStdio(client, config, timeout) {
    var _a;
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: {
        ...getDefaultEnvironment(),
        ...(_a = config.env) != null ? _a : {}
      }
    });
    await client.connect(transport, { timeout });
    return transport;
  }
  async connectViaHttp(serverName, client, config, timeout) {
    var _a;
    const preferSSE = (_a = config.preferSSE) != null ? _a : config.url.pathname.endsWith("/sse");
    let streamableError;
    if (!preferSSE) {
      const streamableTransport = new StreamableHTTPClientTransport(
        config.url,
        {
          requestInit: config.requestInit,
          reconnectionOptions: config.reconnectionOptions,
          authProvider: config.authProvider,
          sessionId: config.sessionId
        }
      );
      try {
        await client.connect(streamableTransport, {
          timeout: Math.min(timeout, 3e3)
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
      authProvider: config.authProvider
    });
    try {
      await client.connect(sseTransport, { timeout });
      return sseTransport;
    } catch (error) {
      await this.safeCloseTransport(sseTransport);
      const streamableMessage = streamableError ? ` Streamable HTTP error: ${this.formatError(streamableError)}.` : "";
      throw new Error(
        `Failed to connect to MCP server "${serverName}" using HTTP transports.${streamableMessage} SSE error: ${this.formatError(error)}.`
      );
    }
  }
  async safeCloseTransport(transport) {
    try {
      await transport.close();
    } catch {
    }
  }
  applyNotificationHandlers(serverName, client) {
    const handlers = this.notificationHandlers.get(serverName);
    if (!handlers) {
      return;
    }
    for (const { schema, handler } of handlers) {
      client.setNotificationHandler(schema, handler);
    }
  }
  applyElicitationHandler(serverName, client) {
    const handler = this.elicitationHandlers.get(serverName);
    if (!handler) {
      return;
    }
    client.setRequestHandler(
      ElicitRequestSchema,
      async (request) => handler(request.params)
    );
  }
  async ensureConnected(name) {
    const serverName = this.normalizeName(name);
    if (this.clientStates.has(serverName)) {
      return;
    }
    const pending = this.pendingConnections.get(serverName);
    if (pending) {
      await pending.promise;
      return;
    }
    const config = this.serverConfigs.get(serverName);
    if (!config) {
      throw new Error(`Unknown MCP server "${serverName}".`);
    }
    await this.connectToServer(serverName, config);
  }
  resetState(name, options) {
    const serverName = this.normalizeName(name);
    this.pendingConnections.delete(serverName);
    this.clientStates.delete(serverName);
    if (!options.preserveConfig) {
      this.serverConfigs.delete(serverName);
    }
  }
  withTimeout(name, options) {
    var _a;
    const serverName = this.normalizeName(name);
    const connectedState = this.clientStates.get(serverName);
    const serverConfig = this.serverConfigs.get(serverName);
    const timeout = (_a = connectedState == null ? void 0 : connectedState.timeout) != null ? _a : serverConfig ? this.getTimeout(serverConfig) : this.defaultTimeout;
    if (!options) {
      return { timeout };
    }
    if (options.timeout === void 0) {
      return { ...options, timeout };
    }
    return options;
  }
  buildCapabilities(config) {
    var _a;
    const capabilities = {
      ...this.defaultCapabilities,
      ...(_a = config.capabilities) != null ? _a : {}
    };
    if (!capabilities.elicitation) {
      capabilities.elicitation = {};
    }
    return capabilities;
  }
  formatError(error) {
    if (error instanceof Error) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  getTimeout(config) {
    var _a;
    return (_a = config.timeout) != null ? _a : this.defaultTimeout;
  }
  isStdioConfig(config) {
    return "command" in config;
  }
  normalizeName(name) {
    const normalized = name.trim();
    if (!normalized) {
      throw new Error("Server name must be a non-empty string.");
    }
    return normalized;
  }
  getClientByName(name) {
    const serverName = this.normalizeName(name);
    const state = this.clientStates.get(serverName);
    if (!state) {
      throw new Error(`MCP server "${serverName}" is not connected.`);
    }
    return state.client;
  }
};
export {
  MCPClientManager,
  mcp_client_manager_exports as mcpClientManager
};
//# sourceMappingURL=index.js.map