"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// index.ts
var index_exports = {};
__export(index_exports, {
  MCPClientManager: () => MCPClientManager
});
module.exports = __toCommonJS(index_exports);
var import_client = require("@modelcontextprotocol/sdk/client/index.js");
var import_sse = require("@modelcontextprotocol/sdk/client/sse.js");
var import_stdio = require("@modelcontextprotocol/sdk/client/stdio.js");
var import_streamableHttp = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
var import_protocol = require("@modelcontextprotocol/sdk/shared/protocol.js");
var import_types = require("@modelcontextprotocol/sdk/types.js");
var MCPClientManager = class {
  constructor(servers = {}, options = {}) {
    this.clientStates = /* @__PURE__ */ new Map();
    this.notificationHandlers = /* @__PURE__ */ new Map();
    this.elicitationHandlers = /* @__PURE__ */ new Map();
    var _a, _b, _c;
    this.defaultClientVersion = (_a = options.defaultClientVersion) != null ? _a : "1.0.0";
    this.defaultCapabilities = { ...(_b = options.defaultCapabilities) != null ? _b : {} };
    this.defaultTimeout = (_c = options.defaultTimeout) != null ? _c : import_protocol.DEFAULT_REQUEST_TIMEOUT_MSEC;
    for (const [name, config] of Object.entries(servers)) {
      void this.connectToServer(name, config);
    }
  }
  listServers() {
    return Array.from(this.clientStates.keys());
  }
  hasServer(serverName) {
    const normalizedServerName = this.normalizeName(serverName);
    return this.clientStates.has(normalizedServerName);
  }
  async connectToServer(serverName, config) {
    var _a;
    const normalizedServerName = this.normalizeName(serverName);
    const timeout = this.getTimeout(config);
    const state = (_a = this.clientStates.get(normalizedServerName)) != null ? _a : { config, timeout };
    state.config = config;
    state.timeout = timeout;
    if (state.client) {
      this.clientStates.set(normalizedServerName, state);
      return state.client;
    }
    if (state.promise) {
      this.clientStates.set(normalizedServerName, state);
      return state.promise;
    }
    const connectionPromise = (async () => {
      var _a2;
      const client = new import_client.Client(
        {
          name: normalizedServerName,
          version: (_a2 = config.version) != null ? _a2 : this.defaultClientVersion
        },
        {
          capabilities: this.buildCapabilities(config)
        }
      );
      this.applyNotificationHandlers(normalizedServerName, client);
      this.applyElicitationHandler(normalizedServerName, client);
      if (config.onError) {
        client.onerror = (error) => {
          var _a3;
          (_a3 = config.onError) == null ? void 0 : _a3.call(config, error);
        };
      }
      client.onclose = () => {
        this.resetState(normalizedServerName);
      };
      let transport;
      if (this.isStdioConfig(config)) {
        transport = await this.connectViaStdio(client, config, timeout);
      } else {
        transport = await this.connectViaHttp(normalizedServerName, client, config, timeout);
      }
      state.client = client;
      state.transport = transport;
      state.promise = void 0;
      this.clientStates.set(normalizedServerName, state);
      return client;
    })().catch((error) => {
      state.promise = void 0;
      state.client = void 0;
      state.transport = void 0;
      this.clientStates.set(normalizedServerName, state);
      throw error;
    });
    state.promise = connectionPromise;
    this.clientStates.set(normalizedServerName, state);
    return connectionPromise;
  }
  async disconnectServer(serverName) {
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
  async disconnectAllServers() {
    const serverNames = this.listServers();
    await Promise.all(serverNames.map((name) => this.disconnectServer(name)));
    for (const serverName of serverNames) {
      const normalizedServerName = this.normalizeName(serverName);
      this.resetState(normalizedServerName);
      this.notificationHandlers.delete(normalizedServerName);
      this.elicitationHandlers.delete(normalizedServerName);
    }
  }
  async listTools(serverName, params, options) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.listTools(params, this.withTimeout(normalizedServerName, options));
  }
  async getTools(names) {
    const targetNames = names && names.length > 0 ? names.map((name) => this.normalizeName(name)) : this.listServers();
    const uniqueNames = Array.from(new Set(targetNames));
    const toolLists = await Promise.all(
      uniqueNames.map(async (serverName) => {
        await this.ensureConnected(serverName);
        const client = this.getClientByName(serverName);
        const result = await client.listTools(void 0, this.withTimeout(serverName));
        return result.tools;
      })
    );
    return { tools: toolLists.flat() };
  }
  async executeTool(serverName, toolName, args = {}, options) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.callTool(
      {
        name: toolName,
        arguments: args
      },
      import_types.CallToolResultSchema,
      this.withTimeout(normalizedServerName, options)
    );
  }
  async listResources(serverName, params, options) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.listResources(params, this.withTimeout(normalizedServerName, options));
  }
  async readResource(serverName, params, options) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.readResource(params, this.withTimeout(normalizedServerName, options));
  }
  async subscribeResource(serverName, params, options) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.subscribeResource(params, this.withTimeout(normalizedServerName, options));
  }
  async unsubscribeResource(serverName, params, options) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.unsubscribeResource(params, this.withTimeout(normalizedServerName, options));
  }
  async listResourceTemplates(serverName, params, options) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.listResourceTemplates(params, this.withTimeout(normalizedServerName, options));
  }
  async listPrompts(serverName, params, options) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.listPrompts(params, this.withTimeout(normalizedServerName, options));
  }
  async getPrompt(serverName, params, options) {
    const normalizedServerName = this.normalizeName(serverName);
    await this.ensureConnected(normalizedServerName);
    const client = this.getClientByName(normalizedServerName);
    return client.getPrompt(params, this.withTimeout(normalizedServerName, options));
  }
  getSessionIdByServer(serverName) {
    const state = this.clientStates.get(this.normalizeName(serverName));
    if (!(state == null ? void 0 : state.transport)) {
      throw new Error(`Unknown MCP server "${serverName}".`);
    }
    if (state.transport instanceof import_streamableHttp.StreamableHTTPClientTransport) {
      return state.transport.sessionId;
    }
    throw new Error(`Server "${serverName}" must be Streamable HTTP to get the session ID.`);
  }
  addNotificationHandler(serverName, schema, handler) {
    var _a, _b, _c;
    const normalizedServerName = this.normalizeName(serverName);
    const serverHandlers = (_a = this.notificationHandlers.get(normalizedServerName)) != null ? _a : /* @__PURE__ */ new Map();
    const handlersForSchema = (_b = serverHandlers.get(schema)) != null ? _b : /* @__PURE__ */ new Set();
    handlersForSchema.add(handler);
    serverHandlers.set(schema, handlersForSchema);
    this.notificationHandlers.set(normalizedServerName, serverHandlers);
    const client = (_c = this.clientStates.get(normalizedServerName)) == null ? void 0 : _c.client;
    if (client) {
      client.setNotificationHandler(schema, this.createNotificationDispatcher(normalizedServerName, schema));
    }
  }
  onResourceListChanged(serverName, handler) {
    this.addNotificationHandler(serverName, import_types.ResourceListChangedNotificationSchema, handler);
  }
  onResourceUpdated(serverName, handler) {
    this.addNotificationHandler(serverName, import_types.ResourceUpdatedNotificationSchema, handler);
  }
  onPromptListChanged(serverName, handler) {
    this.addNotificationHandler(serverName, import_types.PromptListChangedNotificationSchema, handler);
  }
  getClient(serverName) {
    var _a;
    return (_a = this.clientStates.get(this.normalizeName(serverName))) == null ? void 0 : _a.client;
  }
  setElicitationHandler(serverName, handler) {
    var _a;
    const normalizedServerName = this.normalizeName(serverName);
    if (!this.clientStates.has(normalizedServerName)) {
      throw new Error(`Unknown MCP server "${normalizedServerName}".`);
    }
    this.elicitationHandlers.set(normalizedServerName, handler);
    const client = (_a = this.clientStates.get(normalizedServerName)) == null ? void 0 : _a.client;
    if (client) {
      this.applyElicitationHandler(normalizedServerName, client);
    }
  }
  clearElicitationHandler(serverName) {
    var _a;
    const normalizedServerName = this.normalizeName(serverName);
    this.elicitationHandlers.delete(normalizedServerName);
    const client = (_a = this.clientStates.get(normalizedServerName)) == null ? void 0 : _a.client;
    if (client) {
      client.removeRequestHandler("elicitation/create");
    }
  }
  async connectViaStdio(client, config, timeout) {
    var _a;
    const transport = new import_stdio.StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...(0, import_stdio.getDefaultEnvironment)(), ...(_a = config.env) != null ? _a : {} }
    });
    await client.connect(transport, { timeout });
    return transport;
  }
  async connectViaHttp(serverName, client, config, timeout) {
    var _a;
    const preferSSE = (_a = config.preferSSE) != null ? _a : config.url.pathname.endsWith("/sse");
    let streamableError;
    if (!preferSSE) {
      const streamableTransport = new import_streamableHttp.StreamableHTTPClientTransport(config.url, {
        requestInit: config.requestInit,
        reconnectionOptions: config.reconnectionOptions,
        authProvider: config.authProvider,
        sessionId: config.sessionId
      });
      try {
        await client.connect(streamableTransport, { timeout: Math.min(timeout, 3e3) });
        return streamableTransport;
      } catch (error) {
        streamableError = error;
        await this.safeCloseTransport(streamableTransport);
      }
    }
    const sseTransport = new import_sse.SSEClientTransport(config.url, {
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
    const serverHandlers = this.notificationHandlers.get(serverName);
    if (!serverHandlers) {
      return;
    }
    for (const [schema] of serverHandlers) {
      client.setNotificationHandler(schema, this.createNotificationDispatcher(serverName, schema));
    }
  }
  createNotificationDispatcher(serverName, schema) {
    return (notification) => {
      const serverHandlers = this.notificationHandlers.get(serverName);
      const handlersForSchema = serverHandlers == null ? void 0 : serverHandlers.get(schema);
      if (!handlersForSchema || handlersForSchema.size === 0) {
        return;
      }
      for (const handler of handlersForSchema) {
        try {
          handler(notification);
        } catch {
        }
      }
    };
  }
  applyElicitationHandler(serverName, client) {
    const handler = this.elicitationHandlers.get(serverName);
    if (!handler) {
      return;
    }
    client.setRequestHandler(import_types.ElicitRequestSchema, async (request) => handler(request.params));
  }
  async ensureConnected(serverName) {
    const normalizedServerName = this.normalizeName(serverName);
    const state = this.clientStates.get(normalizedServerName);
    if (state == null ? void 0 : state.client) {
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
  resetState(serverName) {
    const normalizedServerName = this.normalizeName(serverName);
    this.clientStates.delete(normalizedServerName);
  }
  withTimeout(serverName, options) {
    var _a;
    const normalizedServerName = this.normalizeName(serverName);
    const state = this.clientStates.get(normalizedServerName);
    const timeout = (_a = state == null ? void 0 : state.timeout) != null ? _a : state ? this.getTimeout(state.config) : this.defaultTimeout;
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
  normalizeName(serverName) {
    const normalized = serverName.trim();
    if (!normalized) {
      throw new Error("Server name must be a non-empty string.");
    }
    return normalized;
  }
  getClientByName(serverName) {
    const normalizedServerName = this.normalizeName(serverName);
    const state = this.clientStates.get(normalizedServerName);
    if (!(state == null ? void 0 : state.client)) {
      throw new Error(`MCP server "${normalizedServerName}" is not connected.`);
    }
    return state.client;
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MCPClientManager
});
//# sourceMappingURL=index.cjs.map