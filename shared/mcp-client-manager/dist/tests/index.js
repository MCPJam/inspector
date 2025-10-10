import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { CallToolResultSchema, ElicitRequestSchema, ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema, PromptListChangedNotificationSchema, } from '@modelcontextprotocol/sdk/types.js';
export class MCPClientManager {
    constructor(servers = {}, options = {}) {
        var _a, _b, _c;
        this.clientStates = new Map();
        this.notificationHandlers = new Map();
        this.elicitationHandlers = new Map();
        this.defaultClientVersion = (_a = options.defaultClientVersion) !== null && _a !== void 0 ? _a : '1.0.0';
        this.defaultCapabilities = { ...((_b = options.defaultCapabilities) !== null && _b !== void 0 ? _b : {}) };
        this.defaultTimeout = (_c = options.defaultTimeout) !== null && _c !== void 0 ? _c : DEFAULT_REQUEST_TIMEOUT_MSEC;
        for (const [name, config] of Object.entries(servers)) {
            void this.connectToServer(name, config);
        }
    }
    listServers() {
        return Array.from(this.clientStates.keys());
    }
    hasServer(name) {
        const serverName = this.normalizeName(name);
        return this.clientStates.has(serverName);
    }
    async connectToServer(name, config) {
        var _a;
        const serverName = this.normalizeName(name);
        const timeout = this.getTimeout(config);
        const state = (_a = this.clientStates.get(serverName)) !== null && _a !== void 0 ? _a : { config, timeout };
        // Update config/timeout on every call
        state.config = config;
        state.timeout = timeout;
        // If already connected, return the client
        if (state.client) {
            this.clientStates.set(serverName, state);
            return state.client;
        }
        // If connection is in-flight, reuse the promise
        if (state.promise) {
            this.clientStates.set(serverName, state);
            return state.promise;
        }
        const connectionPromise = (async () => {
            var _a;
            const client = new Client({
                name: serverName,
                version: (_a = config.version) !== null && _a !== void 0 ? _a : this.defaultClientVersion,
            }, {
                capabilities: this.buildCapabilities(config),
            });
            this.applyNotificationHandlers(serverName, client);
            this.applyElicitationHandler(serverName, client);
            if (config.onError) {
                client.onerror = error => {
                    var _a;
                    (_a = config.onError) === null || _a === void 0 ? void 0 : _a.call(config, error);
                };
            }
            client.onclose = () => {
                this.resetState(serverName);
            };
            let transport;
            if (this.isStdioConfig(config)) {
                transport = await this.connectViaStdio(client, config, timeout);
            }
            else {
                transport = await this.connectViaHttp(serverName, client, config, timeout);
            }
            state.client = client;
            state.transport = transport;
            // clear pending
            state.promise = undefined;
            this.clientStates.set(serverName, state);
            return client;
        })().catch(error => {
            // Clear pending but keep config so the server remains registered
            state.promise = undefined;
            state.client = undefined;
            state.transport = undefined;
            this.clientStates.set(serverName, state);
            throw error;
        });
        state.promise = connectionPromise;
        this.clientStates.set(serverName, state);
        return connectionPromise;
    }
    async disconnectServer(name) {
        const serverName = this.normalizeName(name);
        const client = this.getClientByName(serverName);
        try {
            await client.close();
        }
        finally {
            if (client.transport) {
                await this.safeCloseTransport(client.transport);
            }
            this.resetState(serverName);
        }
    }
    async disconnectAllServers() {
        const serverNames = this.listServers();
        await Promise.all(serverNames.map(name => this.disconnectServer(name)));
        for (const name of serverNames) {
            const serverName = this.normalizeName(name);
            this.resetState(serverName);
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
        const targetNames = names && names.length > 0 ? names.map(name => this.normalizeName(name)) : this.listServers();
        const uniqueNames = Array.from(new Set(targetNames));
        const toolLists = await Promise.all(uniqueNames.map(async (serverName) => {
            await this.ensureConnected(serverName);
            const client = this.getClientByName(serverName);
            const result = await client.listTools(undefined, this.withTimeout(serverName));
            return result.tools;
        }));
        return { tools: toolLists.flat() };
    }
    async executeTool(name, toolName, args = {}, options) {
        const serverName = this.normalizeName(name);
        await this.ensureConnected(serverName);
        const client = this.getClientByName(serverName);
        return client.callTool({
            name: toolName,
            arguments: args,
        }, CallToolResultSchema, this.withTimeout(serverName, options));
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
        return client.subscribeResource(params, this.withTimeout(serverName, options));
    }
    async unsubscribeResource(name, params, options) {
        const serverName = this.normalizeName(name);
        await this.ensureConnected(serverName);
        const client = this.getClientByName(serverName);
        return client.unsubscribeResource(params, this.withTimeout(serverName, options));
    }
    async listResourceTemplates(name, params, options) {
        const serverName = this.normalizeName(name);
        await this.ensureConnected(serverName);
        const client = this.getClientByName(serverName);
        return client.listResourceTemplates(params, this.withTimeout(serverName, options));
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
        if (!(state === null || state === void 0 ? void 0 : state.transport)) {
            throw new Error(`Unknown MCP server "${name}".`);
        }
        if (state.transport instanceof StreamableHTTPClientTransport) {
            return state.transport.sessionId;
        }
        throw new Error(`Server "${name}" must be Streamable HTTP to get the session ID.`);
    }
    addNotificationHandler(name, schema, handler) {
        var _a, _b;
        const serverName = this.normalizeName(name);
        const handlers = (_a = this.notificationHandlers.get(serverName)) !== null && _a !== void 0 ? _a : [];
        handlers.push({ schema, handler });
        this.notificationHandlers.set(serverName, handlers);
        const client = (_b = this.clientStates.get(serverName)) === null || _b === void 0 ? void 0 : _b.client;
        if (client) {
            client.setNotificationHandler(schema, handler);
        }
    }
    onResourceListChanged(name, handler) {
        this.addNotificationHandler(name, ResourceListChangedNotificationSchema, handler);
    }
    onResourceUpdated(name, handler) {
        this.addNotificationHandler(name, ResourceUpdatedNotificationSchema, handler);
    }
    onPromptListChanged(name, handler) {
        this.addNotificationHandler(name, PromptListChangedNotificationSchema, handler);
    }
    getClient(name) {
        var _a;
        return (_a = this.clientStates.get(this.normalizeName(name))) === null || _a === void 0 ? void 0 : _a.client;
    }
    setElicitationHandler(name, handler) {
        var _a;
        const serverName = this.normalizeName(name);
        if (!this.clientStates.has(serverName)) {
            throw new Error(`Unknown MCP server "${serverName}".`);
        }
        this.elicitationHandlers.set(serverName, handler);
        const client = (_a = this.clientStates.get(serverName)) === null || _a === void 0 ? void 0 : _a.client;
        if (client) {
            this.applyElicitationHandler(serverName, client);
        }
    }
    clearElicitationHandler(name) {
        var _a;
        const serverName = this.normalizeName(name);
        this.elicitationHandlers.delete(serverName);
        const client = (_a = this.clientStates.get(serverName)) === null || _a === void 0 ? void 0 : _a.client;
        if (client) {
            client.removeRequestHandler('elicitation/create');
        }
    }
    async connectViaStdio(client, config, timeout) {
        var _a;
        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: { ...getDefaultEnvironment(), ...((_a = config.env) !== null && _a !== void 0 ? _a : {}) },
        });
        await client.connect(transport, { timeout });
        return transport;
    }
    async connectViaHttp(serverName, client, config, timeout) {
        var _a;
        const preferSSE = (_a = config.preferSSE) !== null && _a !== void 0 ? _a : config.url.pathname.endsWith('/sse');
        let streamableError;
        if (!preferSSE) {
            const streamableTransport = new StreamableHTTPClientTransport(config.url, {
                requestInit: config.requestInit,
                reconnectionOptions: config.reconnectionOptions,
                authProvider: config.authProvider,
                sessionId: config.sessionId,
            });
            try {
                await client.connect(streamableTransport, { timeout: Math.min(timeout, 3000) });
                return streamableTransport;
            }
            catch (error) {
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
        }
        catch (error) {
            await this.safeCloseTransport(sseTransport);
            const streamableMessage = streamableError
                ? ` Streamable HTTP error: ${this.formatError(streamableError)}.`
                : '';
            throw new Error(`Failed to connect to MCP server "${serverName}" using HTTP transports.${streamableMessage} SSE error: ${this.formatError(error)}.`);
        }
    }
    async safeCloseTransport(transport) {
        try {
            await transport.close();
        }
        catch {
            // Ignore close errors during cleanup.
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
        client.setRequestHandler(ElicitRequestSchema, async (request) => handler(request.params));
    }
    async ensureConnected(name) {
        const serverName = this.normalizeName(name);
        const state = this.clientStates.get(serverName);
        if (state === null || state === void 0 ? void 0 : state.client) {
            return;
        }
        if (!state) {
            throw new Error(`Unknown MCP server "${serverName}".`);
        }
        if (state.promise) {
            await state.promise;
            return;
        }
        await this.connectToServer(serverName, state.config);
    }
    resetState(name) {
        const serverName = this.normalizeName(name);
        this.clientStates.delete(serverName);
    }
    withTimeout(name, options) {
        var _a;
        const serverName = this.normalizeName(name);
        const state = this.clientStates.get(serverName);
        const timeout = (_a = state === null || state === void 0 ? void 0 : state.timeout) !== null && _a !== void 0 ? _a : (state ? this.getTimeout(state.config) : this.defaultTimeout);
        if (!options) {
            return { timeout };
        }
        if (options.timeout === undefined) {
            return { ...options, timeout };
        }
        return options;
    }
    buildCapabilities(config) {
        var _a;
        const capabilities = {
            ...this.defaultCapabilities,
            ...((_a = config.capabilities) !== null && _a !== void 0 ? _a : {}),
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
        }
        catch {
            return String(error);
        }
    }
    getTimeout(config) {
        var _a;
        return (_a = config.timeout) !== null && _a !== void 0 ? _a : this.defaultTimeout;
    }
    isStdioConfig(config) {
        return 'command' in config;
    }
    normalizeName(name) {
        const normalized = name.trim();
        if (!normalized) {
            throw new Error('Server name must be a non-empty string.');
        }
        return normalized;
    }
    getClientByName(name) {
        const serverName = this.normalizeName(name);
        const state = this.clientStates.get(serverName);
        if (!(state === null || state === void 0 ? void 0 : state.client)) {
            throw new Error(`MCP server "${serverName}" is not connected.`);
        }
        return state.client;
    }
}
