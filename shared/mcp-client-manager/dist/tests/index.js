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
    hasServer(serverName) {
        const normalizedServerName = this.normalizeName(serverName);
        return this.clientStates.has(normalizedServerName);
    }
    async connectToServer(serverName, config) {
        var _a;
        const normalizedServerName = this.normalizeName(serverName);
        const timeout = this.getTimeout(config);
        const state = (_a = this.clientStates.get(normalizedServerName)) !== null && _a !== void 0 ? _a : { config, timeout };
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
            var _a;
            const client = new Client({
                name: normalizedServerName,
                version: (_a = config.version) !== null && _a !== void 0 ? _a : this.defaultClientVersion,
            }, {
                capabilities: this.buildCapabilities(config),
            });
            this.applyNotificationHandlers(normalizedServerName, client);
            this.applyElicitationHandler(normalizedServerName, client);
            if (config.onError) {
                client.onerror = error => {
                    var _a;
                    (_a = config.onError) === null || _a === void 0 ? void 0 : _a.call(config, error);
                };
            }
            client.onclose = () => {
                this.resetState(normalizedServerName);
            };
            let transport;
            if (this.isStdioConfig(config)) {
                transport = await this.connectViaStdio(client, config, timeout);
            }
            else {
                transport = await this.connectViaHttp(normalizedServerName, client, config, timeout);
            }
            state.client = client;
            state.transport = transport;
            // clear pending
            state.promise = undefined;
            this.clientStates.set(normalizedServerName, state);
            return client;
        })().catch(error => {
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
    async disconnectServer(serverName) {
        const normalizedServerName = this.normalizeName(serverName);
        const client = this.getClientByName(normalizedServerName);
        try {
            await client.close();
        }
        finally {
            if (client.transport) {
                await this.safeCloseTransport(client.transport);
            }
            this.resetState(normalizedServerName);
        }
    }
    async disconnectAllServers() {
        const serverNames = this.listServers();
        await Promise.all(serverNames.map(name => this.disconnectServer(name)));
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
    async executeTool(serverName, toolName, args = {}, options) {
        const normalizedServerName = this.normalizeName(serverName);
        await this.ensureConnected(normalizedServerName);
        const client = this.getClientByName(normalizedServerName);
        return client.callTool({
            name: toolName,
            arguments: args,
        }, CallToolResultSchema, this.withTimeout(normalizedServerName, options));
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
        if (!(state === null || state === void 0 ? void 0 : state.transport)) {
            throw new Error(`Unknown MCP server "${serverName}".`);
        }
        if (state.transport instanceof StreamableHTTPClientTransport) {
            return state.transport.sessionId;
        }
        throw new Error(`Server "${serverName}" must be Streamable HTTP to get the session ID.`);
    }
    addNotificationHandler(serverName, schema, handler) {
        var _a, _b, _c;
        const normalizedServerName = this.normalizeName(serverName);
        const serverHandlers = (_a = this.notificationHandlers.get(normalizedServerName)) !== null && _a !== void 0 ? _a : new Map();
        const handlersForSchema = (_b = serverHandlers.get(schema)) !== null && _b !== void 0 ? _b : new Set();
        handlersForSchema.add(handler);
        serverHandlers.set(schema, handlersForSchema);
        this.notificationHandlers.set(normalizedServerName, serverHandlers);
        const client = (_c = this.clientStates.get(normalizedServerName)) === null || _c === void 0 ? void 0 : _c.client;
        if (client) {
            client.setNotificationHandler(schema, this.createNotificationDispatcher(normalizedServerName, schema));
        }
    }
    onResourceListChanged(serverName, handler) {
        this.addNotificationHandler(serverName, ResourceListChangedNotificationSchema, handler);
    }
    onResourceUpdated(serverName, handler) {
        this.addNotificationHandler(serverName, ResourceUpdatedNotificationSchema, handler);
    }
    onPromptListChanged(serverName, handler) {
        this.addNotificationHandler(serverName, PromptListChangedNotificationSchema, handler);
    }
    getClient(serverName) {
        var _a;
        return (_a = this.clientStates.get(this.normalizeName(serverName))) === null || _a === void 0 ? void 0 : _a.client;
    }
    setElicitationHandler(serverName, handler) {
        var _a;
        const normalizedServerName = this.normalizeName(serverName);
        if (!this.clientStates.has(normalizedServerName)) {
            throw new Error(`Unknown MCP server "${normalizedServerName}".`);
        }
        this.elicitationHandlers.set(normalizedServerName, handler);
        const client = (_a = this.clientStates.get(normalizedServerName)) === null || _a === void 0 ? void 0 : _a.client;
        if (client) {
            this.applyElicitationHandler(normalizedServerName, client);
        }
    }
    clearElicitationHandler(serverName) {
        var _a;
        const normalizedServerName = this.normalizeName(serverName);
        this.elicitationHandlers.delete(normalizedServerName);
        const client = (_a = this.clientStates.get(normalizedServerName)) === null || _a === void 0 ? void 0 : _a.client;
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
        const serverHandlers = this.notificationHandlers.get(serverName);
        if (!serverHandlers) {
            return;
        }
        for (const [schema] of serverHandlers) {
            client.setNotificationHandler(schema, this.createNotificationDispatcher(serverName, schema));
        }
    }
    createNotificationDispatcher(serverName, schema) {
        return notification => {
            const serverHandlers = this.notificationHandlers.get(serverName);
            const handlersForSchema = serverHandlers === null || serverHandlers === void 0 ? void 0 : serverHandlers.get(schema);
            if (!handlersForSchema || handlersForSchema.size === 0) {
                return;
            }
            for (const handler of handlersForSchema) {
                try {
                    handler(notification);
                }
                catch {
                    // Swallow individual handler errors to avoid breaking other listeners.
                }
            }
        };
    }
    applyElicitationHandler(serverName, client) {
        const handler = this.elicitationHandlers.get(serverName);
        if (!handler) {
            return;
        }
        client.setRequestHandler(ElicitRequestSchema, async (request) => handler(request.params));
    }
    async ensureConnected(serverName) {
        const normalizedServerName = this.normalizeName(serverName);
        const state = this.clientStates.get(normalizedServerName);
        if (state === null || state === void 0 ? void 0 : state.client) {
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
    normalizeName(serverName) {
        const normalized = serverName.trim();
        if (!normalized) {
            throw new Error('Server name must be a non-empty string.');
        }
        return normalized;
    }
    getClientByName(serverName) {
        const normalizedServerName = this.normalizeName(serverName);
        const state = this.clientStates.get(normalizedServerName);
        if (!(state === null || state === void 0 ? void 0 : state.client)) {
            throw new Error(`MCP server "${normalizedServerName}" is not connected.`);
        }
        return state.client;
    }
}
