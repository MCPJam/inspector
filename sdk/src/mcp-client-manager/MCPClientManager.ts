/**
 * MCPClientManager - Manages multiple MCP server connections
 */

import {
  type CallToolResult,
  Client,
  getSupportedElicitationModes,
  type ClientOptions,
  type GetPromptResult,
  InMemoryResponseCacheStore,
  type JsonSchemaType,
  type LoggingLevel,
  type ReadResourceResult,
  type Request,
  SSEClientTransport,
  type ServerCapabilities,
  StreamableHTTPClientTransport,
  type Transport,
  type RequestOptions,
  withInputRequired,
} from "@modelcontextprotocol/client";
// beta.4 moved the Node stdio client transport to the `/stdio` subpath.
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

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
  CacheEventLogger,
  Tool,
  AiSdkTool,
} from "./types.js";
import type { MCPServerReplayConfig } from "../eval-reporting-types.js";

import {
  DEFAULT_CLIENT_VERSION,
  DEFAULT_ELICITATION_TIMEOUT_EXTENSION_MS,
  DEFAULT_TIMEOUT,
  HTTP_CONNECT_TIMEOUT,
} from "./constants.js";
import { isMethodUnavailableError, formatError } from "./error-utils.js";
import {
  MCPAuthError,
  isAuthError,
  isUnauthorized401,
  isInsufficientScopeError,
} from "./errors.js";
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
  LoggingMessageNotificationMethod,
  PromptListChangedNotificationMethod,
  ResourceListChangedNotificationMethod,
  ResourceUpdatedNotificationMethod,
  type NotificationMethodName,
  type NotificationHandler,
} from "./notification-handlers.js";
import { ElicitationManager } from "./elicitation.js";
import type { DeclaredElicitationCapability } from "./elicitation.js";
import type { ElicitationMode } from "./types.js";
import { createElicitationTimeoutSuspension } from "./elicitation-timeout.js";
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
import type { ModelVisibleMcpToolResults } from "../host-config/types.js";
import {
  applyRuntimeClientCapabilities,
  getDefaultClientCapabilities,
  mergeClientCapabilities,
  normalizeClientCapabilities,
} from "./capabilities.js";
import { assertCallToolResult, isCreateTaskResult } from "./result-guards.js";
import { wrapLegacyClient } from "./managed-mcp-client-factory.js";
import { ObservableResponseCache } from "./observable-response-cache.js";
import { resolveVersionNegotiation } from "./version-negotiation.js";
import { DialectAwareJsonSchemaValidator } from "./dialect-aware-json-schema-validator.js";
import { isStatelessProtocolVersion } from "./mcp-protocol-version.js";
import { type ManagedMcpClient } from "./managed-mcp-client.js";
import {
  DEFAULT_MAX_MRTR_ROUNDS,
  defaultResultSchemaForMethod,
  runInputRequiredOperation,
  type ElicitationContentValidator,
  type InputRequiredResult,
  type MrtrInputCollector,
  type MrtrLegSender,
} from "./mrtr-driver.js";


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
  private readonly retryAbortControllers = new Map<
    string,
    Set<AbortController>
  >();
  private readonly unauthorizedRefreshInFlight = new Map<
    string,
    Promise<string>
  >();
  /**
   * Per-server modern per-request log level. A present entry means "inject
   * `LOG_LEVEL_META_KEY` into every request's `_meta` on the modern era";
   * an ABSENT entry means opt-out (no `_meta` key). Read live by each
   * server's `LogLevelMetaClient` decorator via the provider closure wired
   * at connect, so `setPerRequestLogLevel` takes effect without reconnect.
   */
  private readonly perRequestLogLevels = new Map<string, LoggingLevel>();

  // Managers for specific features
  private readonly notificationManager = new NotificationManager();
  private readonly elicitationManager = new ElicitationManager();

  /**
   * Per-server collectors for the modern multi-round-trip (`input_required`)
   * loop. When a collector is registered for a server, `executeTool`,
   * `readResource`, and `getPrompt` drive the manual MRTR loop
   * (`mrtr-driver.ts`) so an `input_required` result is collected and the
   * operation retried; when none is registered the verbs keep their exact
   * pre-MRTR behavior (an `input_required` from a modern server then surfaces
   * as the SDK's typed `UnsupportedResultType` rather than being silently
   * mishandled). The collector seam is what PR2 (local UI), PR6 (CLI), and the
   * hosted PRs plug into.
   */
  private readonly mrtrInputCollectors = new Map<string, MrtrInputCollector>();

  /** MCPJam-owned MRTR round cap (see `mrtr-driver.ts`). */
  private readonly mrtrMaxRounds = DEFAULT_MAX_MRTR_ROUNDS;

  /**
   * Strict self-validation of collected elicitation content against each
   * request's `requestedSchema` (§12.1.11). Unlike the tool-output validator,
   * an unknown JSON-Schema dialect is treated as INVALID (not fail-open):
   * elicitation content is untrusted, so an exotic dialect must not wave it
   * through. The dialect-aware validator is constructed per call so the
   * throwing `onUnknownDialect` never leaks state between validations.
   */
  private readonly mrtrElicitationContentValidator: ElicitationContentValidator =
    (requestedSchema, content) => {
      if (
        typeof requestedSchema !== "object" ||
        requestedSchema === null
      ) {
        return { valid: false, error: "requestedSchema is not an object" };
      }
      const strict = new DialectAwareJsonSchemaValidator({
        onUnknownDialect: (dialect) => {
          throw new Error(
            `Elicitation content declares unsupported JSON Schema dialect "${dialect}".`
          );
        },
      });
      let validate;
      try {
        validate = strict.getValidator(requestedSchema as JsonSchemaType);
      } catch (error) {
        return {
          valid: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const result = validate(content);
      return { valid: result.valid, error: result.errorMessage };
    };

  /**
   * Tool output-schema validator for the MRTR path. `requestWithSchema`
   * bypasses upstream `callTool`'s output-schema assertion, so we reconstruct
   * it on the final complete result. Fail-open on an unknown dialect, matching
   * upstream's tool-output behavior (see `DialectAwareJsonSchemaValidator`).
   */
  private readonly mrtrToolOutputValidator = new DialectAwareJsonSchemaValidator();

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
  private readonly cacheEventLogger?: CacheEventLogger;
  private readonly defaultRetryPolicy: RetryPolicy;
  private readonly lazyConnect: boolean;
  private readonly elicitationTimeoutExtensionMs: number;

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
    this.cacheEventLogger = options.cacheEventLogger;
    this.defaultRetryPolicy = normalizeRetryPolicy(options.retryPolicy);
    this.lazyConnect = options.lazyConnect ?? false;
    this.elicitationTimeoutExtensionMs = Math.max(
      0,
      options.elicitationTimeoutExtensionMs ??
        DEFAULT_ELICITATION_TIMEOUT_EXTENSION_MS
    );

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
    // Peel the `ManagedMcpClient` wrapper chain down to the raw upstream
    // `Client`. Each wrapper exposes the next layer via `.inner`:
    // `LogLevelMetaClient` (present on every connection, wrapping) →
    // `OfficialSdkClientAdapter` → upstream `Client`. The upstream `Client`
    // does NOT expose `.inner`, so unwrap until `.inner` is absent. A single
    // `.inner` hop would stop at the adapter (a `ManagedMcpClient` lacking
    // `complete`/`setLoggingLevel`-with-result), which is what external
    // consumers of this deprecated API — and the conformance runner — expect
    // to be the raw `Client`. Structural check keeps this independent of an
    // instanceof tree shaken across the SDK boundary.
    let current: unknown = managed;
    while (
      current &&
      typeof current === "object" &&
      (current as { inner?: unknown }).inner
    ) {
      current = (current as { inner?: unknown }).inner;
    }
    return current as Client;
  }

  /**
   * Gets the `ManagedMcpClient` for a server — works for both the legacy
   * adapter and the 2026-07-28 stateless preview. Use this in new
   * code instead of `getClient()`.
   */
  getManagedClient(
    serverId: string
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
    this.perRequestLogLevels.delete(serverId);
    // Purge the MRTR collector too; otherwise a re-registered server inherits
    // the previous owner's collector closure and stale `elicitation` capability.
    this.mrtrInputCollectors.delete(serverId);
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
   * const agent = new HostRunner({ tools, model: "openai/gpt-4o", apiKey });
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
      /**
       * When true, include SEP-1865 app-only tools (`_meta.ui.visibility = ["app"]`)
       * in the returned tool set. Defaults to `false` (spec-compliant: app-only
       * tools are hidden from the model). Use this only when intentionally
       * mirroring a host that does not implement visibility filtering.
       */
      includeAppOnly?: boolean;
      /** Host policy for model visibility of MCP tool-result content/resources. */
      modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
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
            includeAppOnly: options.includeAppOnly,
            modelVisibleMcpToolResults: options.modelVisibleMcpToolResults,
            readResource: async ({ uri, options: readOptions }) => {
              const requestOptions = readOptions?.abortSignal
                ? { signal: readOptions.abortSignal }
                : undefined;
              return this.readResource(id, { uri }, requestOptions);
            },
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
              return assertCallToolResult(result, `Tool "${name}" result`);
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

    // Modern multi-round-trip: when a collector is registered and this is not a
    // task-augmented call, drive the manual `input_required` loop. A complete
    // result on the first leg exits immediately, so legacy servers are
    // unaffected.
    const mrtrCollect = this.mrtrInputCollectors.get(serverId);
    if (mrtrCollect && request.task === undefined) {
      return this.executeToolWithInputRequired(
        serverId,
        { name: toolName, arguments: args },
        request,
        mrtrCollect
      );
    }

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
          // TODO(Phase 6 / io.modelcontextprotocol/tasks): beta.4 removed the
          // `task` field from RequestOptions (tasks moved to the extension).
          // Cast to keep this legacy task-augmented path compiling until Phase 6
          // rebuilds it on the new extension shape.
          { ...mergedOptions, task: taskValue } as RequestOptions
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

      return this.withElicitationTimeoutSuspension(
        serverId,
        mergedOptions,
        (callOptions) => client.callTool(callParams, callOptions)
      );
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
    const mrtrCollect = this.mrtrInputCollectors.get(serverId);
    if (mrtrCollect) {
      return this.readResourceWithInputRequired(
        serverId,
        params,
        options,
        mrtrCollect
      );
    }
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
    const mrtrCollect = this.mrtrInputCollectors.get(serverId);
    if (mrtrCollect) {
      return this.getPromptWithInputRequired(
        serverId,
        params,
        options,
        mrtrCollect
      );
    }
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
   * Modern (2026-07-28) per-request logging opt-in. One user-facing concept
   * ("set a level for this server"), era-specific delivery: on the modern era
   * the level rides on every request as `_meta[LOG_LEVEL_META_KEY]` (injected
   * by the server's `LogLevelMetaClient` decorator); on the legacy era this is
   * inert — use {@link setLoggingLevel} there.
   *
   * Passing `undefined` opts out: the key becomes ABSENT on the wire (absence
   * is semantic — we never send an empty/null level). Takes effect on the next
   * request without a reconnect. No-op-safe before connect: the level is
   * stored and read live once the client exists.
   */
  setPerRequestLogLevel(
    serverId: string,
    level: LoggingLevel | undefined
  ): void {
    if (level === undefined) {
      this.perRequestLogLevels.delete(serverId);
    } else {
      this.perRequestLogLevels.set(serverId, level);
    }
  }

  /**
   * Which logging mechanism is live for a server, for UI selection:
   *   - `"per-request-meta"` — modern era + server advertises `logging`; set a
   *     level with {@link setPerRequestLogLevel}.
   *   - `"setLevel"` — legacy era + server advertises `logging`; set a level
   *     with {@link setLoggingLevel}.
   *   - `"none"` — no live client, or the server does not advertise `logging`.
   */
  getLoggingMechanism(
    serverId: string
  ): "setLevel" | "per-request-meta" | "none" {
    const client = this.liveClientStates.get(serverId)?.client;
    if (!client) {
      return "none";
    }
    if (!client.getServerCapabilities?.()?.logging) {
      return "none";
    }
    return client.getProtocolEra?.() === "modern"
      ? "per-request-meta"
      : "setLevel";
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

  /**
   * Registers a handler for server→client log records
   * (`notifications/message`). Works on BOTH eras: legacy servers stream
   * these after `logging/setLevel`; modern servers stream them inline within
   * the originating request's response. Follows the same
   * `NotificationManager.addHandler` + `applyToClient` path as the
   * `list_changed` registrations, so a handler registered before connect is
   * re-applied when the client is (re)built.
   */
  onLogMessage(serverId: string, handler: NotificationHandler): void {
    this.addNotificationHandler(
      serverId,
      LoggingMessageNotificationMethod,
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
      this.elicitationManager.applyToClient(
        serverId,
        client,
        this.negotiatedElicitationCapability(state)
      );
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
        this.elicitationManager.applyToClient(
          serverId,
          client,
          this.negotiatedElicitationCapability(state)
        );
      } else {
        this.elicitationManager.removeFromClient(client);
      }
    }
  }

  /**
   * Registers the multi-round-trip (`input_required`) input collector for a
   * server. Once set, `executeTool` / `readResource` / `getPrompt` drive the
   * manual MRTR loop: an `input_required` result is validated (undeclared
   * roots/sampling and unsupported elicitation modes are rejected before any
   * UI), its embedded requests are handed to `collect`, the collected
   * responses are self-validated against each `requestedSchema`, and the
   * operation is retried — up to the MCPJam-owned round cap. `collect` MUST
   * reject on abort (never return a synthetic decline) and returns
   * `ElicitResult`-shaped responses keyed by the server's request keys.
   */
  setMrtrInputCollector(serverId: string, collect: MrtrInputCollector): void {
    // Intentionally NOT gated on prior registration: a 2026-07-28 server checks
    // the request's declared client capabilities before embedding an
    // elicitation, so a collector must be registrable BEFORE connect for
    // `elicitation` to be advertised on the connect envelope (see
    // `buildCapabilities`). Registering for an as-yet-unknown server is a no-op
    // until that server connects.
    this.mrtrInputCollectors.set(serverId, collect);
  }

  /** Removes a server's MRTR input collector. */
  clearMrtrInputCollector(serverId: string): void {
    this.mrtrInputCollectors.delete(serverId);
  }

  /**
   * Sets a global elicitation callback for all servers.
   */
  setElicitationCallback(callback: ElicitationCallback): void {
    this.elicitationManager.setGlobalCallback(callback);
    for (const [serverId, state] of this.liveClientStates.entries()) {
      if (state.client && this.hasNegotiatedElicitation(state)) {
        this.elicitationManager.applyToClient(
          serverId,
          state.client,
          this.negotiatedElicitationCapability(state)
        );
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
        this.elicitationManager.applyToClient(
          serverId,
          state.client,
          this.negotiatedElicitationCapability(state)
        );
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
        name: config.clientInfo?.name ?? this.defaultClientName ?? serverId,
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
      // Resolve the outbound protocol-version pin. The upstream caller
      // (inspector backend) has already done host-default + per-server
      // override resolution AND `isKnownProtocolVersion` membership
      // validation; we accept the stamped value here without
      // re-validating. Predicate-based routing — stateful pins (or no
      // pin) route through the legacy upstream Client path; stateless
      // pins route through the preview client.
      const resolvedProtocolVersion = !this.isStdioConfig(config)
        ? config.mcpProtocolVersion
        : undefined;
      const wantsStateless =
        resolvedProtocolVersion !== undefined &&
        isStatelessProtocolVersion(resolvedProtocolVersion);
      // Stateful `mcpProtocolVersion` pin (e.g. `"2025-11-25"`) propagates
      // into the legacy `Client`'s `supportedProtocolVersions` accept-list
      // so `initialize.params.protocolVersion` actually goes out as the
      // pinned value rather than the SDK's built-in newest default. An
      // explicit `supportedProtocolVersions` (per-server or default) still
      // wins — pinning at one layer while overriding the other would be
      // ambiguous and the override is the more specific signal.
      const supportedProtocolVersions =
        config.supportedProtocolVersions ??
        this.defaultSupportedProtocolVersions ??
        (!wantsStateless && resolvedProtocolVersion !== undefined
          ? [resolvedProtocolVersion]
          : undefined);
      const versionNegotiation = resolveVersionNegotiation(
        resolvedProtocolVersion
      );
      const clientOptions: ClientOptions = {
        capabilities: clientCapabilities,
        // Manual multi-round-trip mode (2026-07-28 `input_required`, spec §12).
        // MCPJam drives the loop itself (`mrtr-driver.ts`) so a debugger shows
        // every round and a hosted worker never blocks while a human answers.
        // The SDK's automatic driver — and its built-in `maxRounds`/
        // `InputRequiredRoundsExceeded` cap — applies only to `autoFulfill:
        // true`; with it off, an `input_required` result surfaces (via
        // `allowInputRequired: true` on the explicit-schema call) instead of
        // being auto-fulfilled, and MCPJam owns the round cap.
        inputRequired: { autoFulfill: false },
        // Dialect-aware replacement for the upstream default validator,
        // which rejects (rather than validates) declared draft-07 schemas
        // and thereby fails tools/call against every v1-SDK server that
        // sets an outputSchema.
        jsonSchemaValidator: new DialectAwareJsonSchemaValidator(),
        ...(supportedProtocolVersions && supportedProtocolVersions.length > 0
          ? { supportedProtocolVersions }
          : {}),
        ...(versionNegotiation ? { versionNegotiation } : {}),
        // Cache-serve provenance. Only when a `cacheEventLogger` is wired do we
        // supply our own store; otherwise the client allocates its default
        // `InMemoryResponseCacheStore` and behavior is byte-identical. We wrap
        // a FRESH in-memory store per connection (the upstream default) so
        // freshness/scope semantics are unchanged — the wrapper only observes.
        // `defaultCacheTtlMs` is intentionally left at its `0` default: a
        // result without a server `ttlMs` is stored but never served.
        ...(this.cacheEventLogger
          ? {
              responseCacheStore: new ObservableResponseCache(
                new InMemoryResponseCacheStore(),
                { serverId, onHit: this.cacheEventLogger }
              ),
            }
          : {}),
      };

      // Both eras go through the official upstream `Client`, constructed
      // early here so the notification / elicitation / error wiring
      // attaches once and stays. A modern (2026-07-28) pin is a
      // `versionNegotiation` on `clientOptions` (above), not a branch to a
      // second client implementation.
      const upstreamClient = new Client(
        resolvedClientInfo as { name: string; version: string },
        clientOptions
      );
      // Wire the modern per-request logging opt-in. The provider reads the
      // per-server level live, so `setPerRequestLogLevel` takes effect with no
      // reconnect; the decorator itself only injects on the modern era.
      const managedClient: ManagedMcpClient = wrapLegacyClient(
        upstreamClient,
        () => this.perRequestLogLevels.get(serverId),
      );
      client = managedClient;

      // Apply handlers (no-ops for the stateless stub; rewired after
      // the real client is constructed inside connectViaHttp).
      this.notificationManager.applyToClient(serverId, client);
      if (this.defaultProgressHandler) {
        applyProgressHandler(serverId, client, this.defaultProgressHandler);
      }
      const declaredElicitation = (
        clientCapabilities as Record<string, unknown>
      ).elicitation;
      if (declaredElicitation != null) {
        this.elicitationManager.applyToClient(
          serverId,
          client,
          declaredElicitation as DeclaredElicitationCapability
        );
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
          state
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
      // advertising the logging capability. The 2026-07-28 stateless
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
      throw this.annotateStdioConnectError(serverId, error, stderrOutput);
    }

    state.stdioStderrCleanup = stderrDrain.cleanup;
    return underlying;
  }

  private async connectViaHttp(
    serverId: string,
    client: ManagedMcpClient,
    config: HttpServerConfig,
    timeout: number,
    state: LiveClientState
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


    let streamableError: unknown;

    if (!preferSSE) {
      const streamableTransport = new StreamableHTTPClientTransport(url, {
        requestInit,
        reconnectionOptions: config.reconnectionOptions,
        authProvider: effectiveAuthProvider,
        sessionId: config.sessionId,
        // SEP-2350 step-up. MCPJam drives interactive re-authorization on the
        // CLIENT (a browser redirect through `initiateOAuth` /
        // `ensureAuthorizedForReconnect`), not inside this transport. This
        // transport runs server-side over a bearer `accessToken` or a
        // `RefreshTokenOAuthProvider` — neither can complete an interactive
        // step-up here. Under the upstream default (`"reauthorize"`) a 403
        // `insufficient_scope` against a refresh-token server would run
        // `auth(..., forceReauthorization: true)`, hit
        // `RefreshTokenOAuthProvider.redirectToAuthorization()` and throw a
        // bare "Non-interactive OAuth flow" — losing the challenge scopes.
        // `"throw"` makes the transport surface a clean
        // `InsufficientScopeError` (carrying `requiredScope` /
        // `resourceMetadataUrl`) that the host serializes to the client, which
        // owns the union-scope re-authorization and the bounded per-session
        // retry (§10.5#5). Cross-request loop bounding is host responsibility.
        onInsufficientScope: "throw",
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
        // SEP-2350: a connect-time `403 insufficient_scope` surfaces here as a
        // clean `InsufficientScopeError` (transport built
        // `onInsufficientScope: "throw"` above). Rethrow it immediately —
        // falling through to the SSE transport would either discard the
        // challenge (SSE happens to succeed) or downgrade it to a generic
        // `MCPAuthError` (SSE fails), stripping `requiredScope` /
        // `resourceMetadataUrl`. SSE cannot repair scope, so there is nothing
        // to gain by trying it; preserve the original error so the host can
        // serialize the challenge and drive the union-scope re-authorization.
        if (isInsufficientScopeError(error)) {
          throw error;
        }
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

  private createStdioStderrDrain(transport: StdioClientTransport): {
    cleanup: () => void;
    getCapturedOutput: () => string;
  } {
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
    const baseMessage = error instanceof Error ? error.message : String(error);
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
    options?: ClientRequestOptions
  ): ClientRequestOptions {
    const state = this.registeredServers.get(serverId);
    const timeout = state?.timeout ?? this.defaultTimeout;

    if (!options) return { timeout };
    // Spread preserves any `cacheMode` the caller threaded so it survives into
    // the underlying cacheable-verb call.
    if (options.timeout === undefined) return { ...options, timeout };
    return options;
  }

  private withProgressHandler(
    serverId: string,
    options?: ClientRequestOptions
  ): ClientRequestOptions {
    const mergedOptions = this.withTimeout(serverId, options);

    if (!mergedOptions.onprogress && this.defaultProgressHandler) {
      const progressToken = `${serverId}-request-${Date.now()}-${++this
        .progressTokenCounter}`;
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

  /**
   * Runs a tool call under an elicitation-aware timeout budget.
   *
   * The request timeout is a *server* budget. A tool call blocked because the
   * server asked the user a question is not hung, so its clock stops while an
   * elicitation is pending — but a genuinely hung server must still die at the
   * base timeout, and a human who never answers must not block forever.
   *
   * Mechanics (see `elicitation-timeout.ts` for the budget accounting):
   *  - No elicitation handler for this server ⇒ pure passthrough, no watchdog,
   *    no behavior change whatsoever.
   *  - Otherwise the upstream hard timeout is **overridden** to
   *    `base + extension` to move it out of the way (`withTimeout` only
   *    *injects* a timeout when unset, so a plain merge would not take), and
   *    the real budget is enforced locally by the watchdog.
   *  - The watchdog's signal is composed with the caller's — the AI SDK
   *    forwards its own `abortSignal` into these request options and it must
   *    keep working.
   */
  private async withElicitationTimeoutSuspension<T>(
    serverId: string,
    options: RequestOptions,
    run: (options: RequestOptions) => Promise<T>
  ): Promise<T> {
    if (!this.elicitationManager.hasHandler(serverId)) {
      return run(options);
    }

    const baseTimeoutMs =
      options.timeout ??
      this.registeredServers.get(serverId)?.timeout ??
      this.defaultTimeout;
    const pendingSequenceAtStart = this.elicitationManager.getPendingSequence();

    const suspension = createElicitationTimeoutSuspension({
      serverId,
      baseTimeoutMs,
      extensionMs: this.elicitationTimeoutExtensionMs,
      callerSignal: options.signal,
      // Age-bound the check with this call's OWN elicitation budget. Without
      // it, a handler that never settles (e.g. its `tools/call` was aborted by
      // this very watchdog, so its `finally` never ran) would pin the server
      // "pending" for the process lifetime and silently pause the clock of
      // every later call — unbounded timeouts, with nothing in the logs.
      // An entry older than this budget would have blown it anyway.
      hasPending: () =>
        this.elicitationManager.hasPendingForServer(
          serverId,
          this.elicitationTimeoutExtensionMs,
          pendingSequenceAtStart,
        ),
    });

    try {
      return await run({
        ...options,
        timeout: suspension.timeoutMs,
        signal: suspension.signal,
      });
    } finally {
      suspension.dispose();
    }
  }

  private buildCapabilities(
    serverId: string,
    config: MCPServerConfig
  ): ClientCapabilityOptions {
    // Advertise `elicitation` when EITHER a legacy elicitation handler OR a
    // modern MRTR input collector is registered — a 2026-07-28 server checks
    // the request's declared client capabilities before it will embed an
    // `elicitation/create` in an `input_required` result, so a collector that
    // is registered before connect must be reflected here. roots/sampling are
    // never advertised (this client never fulfils them; MRTR rejects embedded
    // roots/sampling at the result — advertise = enforce).
    const hasElicitationHandler =
      this.elicitationManager.hasHandler(serverId) ||
      this.mrtrInputCollectors.has(serverId);
    if (config.clientCapabilities) {
      const exactCapabilities = normalizeClientCapabilities(
        config.clientCapabilities
      ) as Record<string, unknown>;

      if (!hasElicitationHandler) {
        delete exactCapabilities.elicitation;
      }

      return exactCapabilities as ClientCapabilityOptions;
    }

    const configuredCapabilities = mergeClientCapabilities(
      this.defaultCapabilities,
      config.capabilities
    );

    return applyRuntimeClientCapabilities(configuredCapabilities, {
      elicitation: hasElicitationHandler,
    });
  }

  /**
   * The elicitation modes an MRTR round may embed for this server, derived from
   * the `elicitation` capability actually advertised on the wire.
   *
   * The spec puts the obligation on the server ("Servers MUST NOT send
   * elicitation requests with modes that are not supported by the client"), so
   * this is the client-side backstop against a noncompliant or hostile server —
   * the same check `assertElicitationModeDeclared` already applies to inbound
   * `elicitation/create`, which the MRTR path otherwise skipped by defaulting to
   * every mode this client can render. Without it, a caller pinning an exact
   * form-only capability could still be shown a URL consent prompt.
   *
   * Returned as a thunk: the declaration is only on record after `initialize`,
   * and the connection is established inside the operation's first leg.
   */
  private mrtrSupportedElicitationModes(
    serverId: string
  ): () => readonly ElicitationMode[] {
    return () => {
      const declared = this.negotiatedElicitationCapability(
        this.liveClientStates.get(serverId)
      );
      // No declaration on record: mirror the inbound path, which allows form
      // (the legacy default) and rejects url absent an explicit declaration.
      if (declared === undefined) return ["form"];
      const { supportsFormMode, supportsUrlMode } = getSupportedElicitationModes(
        declared as Parameters<typeof getSupportedElicitationModes>[0]
      );
      const modes: ElicitationMode[] = [];
      if (supportsFormMode) modes.push("form");
      if (supportsUrlMode) modes.push("url");
      return modes;
    };
  }

  private hasNegotiatedElicitation(state?: LiveClientState): boolean {
    return this.negotiatedElicitationCapability(state) != null;
  }

  /**
   * The `elicitation` client capability actually advertised to this server on
   * the wire, for `applyToClient` to enforce declared modes against.
   */
  private negotiatedElicitationCapability(
    state?: LiveClientState
  ): DeclaredElicitationCapability {
    const capabilities = state?.initializedClientCapabilities as
      | Record<string, unknown>
      | undefined;
    const elicitation = capabilities?.elicitation;
    return elicitation != null
      ? (elicitation as DeclaredElicitationCapability)
      : undefined;
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

  // ===========================================================================
  // Multi-round-trip (`input_required`) drivers — spec §12.
  //
  // Each verb's MRTR path drives the shared serializable stepper
  // (`mrtr-driver.ts`). The wire legs go through a verb-specific SENDER so
  // Phase-3 helper semantics are preserved: `readResource` keeps the response
  // cache, tool + prompt legs carry the modern per-request log-level `_meta`
  // via the `requestWithSchema` decorator, and the final tool result is
  // re-validated against its output schema (reconstructing what the bypassed
  // upstream `callTool` would have asserted). The MRTR loop lives OUTSIDE the
  // per-leg retry/timeout wrappers, so a transient failure on round N retries
  // only that leg — it never restarts the operation at round zero.
  // ===========================================================================

  private async executeToolWithInputRequired(
    serverId: string,
    callParams: { name: string; arguments?: Record<string, unknown> },
    request: ExecuteToolRequest,
    collect: MrtrInputCollector
  ): Promise<CallToolResult> {
    const baseOptions = request.request;
    const retryPolicy = request.retry ?? { retries: 0, retryDelayMs: 0 };
    const sender: MrtrLegSender<CallToolResult> = (req) =>
      this.runRetriedOperation(
        serverId,
        baseOptions,
        retryPolicy,
        async (signal) => {
          await this.ensureConnected(serverId, signal);
          const client = this.getClientOrThrow(serverId);
          const mergedOptions = this.withProgressHandler(serverId, baseOptions);
          return this.withElicitationTimeoutSuspension(
            serverId,
            mergedOptions,
            (callOptions) =>
              client.requestWithSchema(
                req as Request,
                withInputRequired(defaultResultSchemaForMethod("tools/call")),
                // Pass `callOptions` through untouched (matching the legacy
                // `client.callTool(callParams, callOptions)` sibling): it carries
                // the composed elicitation-timeout watchdog signal. Overwriting
                // `.signal` with the outer retry `signal` would drop that
                // watchdog; the outer abort is already enforced by
                // `runRetriedOperation`'s `awaitWithAbort` wrapper.
                { ...callOptions, allowInputRequired: true }
              ) as Promise<CallToolResult | InputRequiredResult>
          );
        }
      );

    return runInputRequiredOperation<CallToolResult>({
      method: "tools/call",
      params: callParams,
      sender,
      collectInput: collect,
      validateContent: this.mrtrElicitationContentValidator,
      supportedElicitationModes:
        this.mrtrSupportedElicitationModes(serverId),
      validateResponse: (result) =>
        this.validateToolOutputSchema(serverId, callParams.name, result),
      requestOptions: baseOptions,
      maxRounds: this.mrtrMaxRounds,
      signal: baseOptions?.signal,
    });
  }

  private async readResourceWithInputRequired(
    serverId: string,
    params: ReadResourceParams,
    options: ClientRequestOptions | undefined,
    collect: MrtrInputCollector
  ): Promise<ReadResourceResult> {
    const sender: MrtrLegSender<ReadResourceResult> = (req) =>
      this.runRetryableReadOperation(serverId, options, (client) =>
        client.readResource(req.params as ReadResourceParams, {
          ...this.withProgressHandler(serverId, options),
          allowInputRequired: true,
        }) as Promise<ReadResourceResult | InputRequiredResult>
      );

    return runInputRequiredOperation<ReadResourceResult>({
      method: "resources/read",
      params: params as Record<string, unknown>,
      sender,
      collectInput: collect,
      validateContent: this.mrtrElicitationContentValidator,
      supportedElicitationModes:
        this.mrtrSupportedElicitationModes(serverId),
      requestOptions: options,
      maxRounds: this.mrtrMaxRounds,
      signal: options?.signal,
    });
  }

  private async getPromptWithInputRequired(
    serverId: string,
    params: GetPromptParams,
    options: ClientRequestOptions | undefined,
    collect: MrtrInputCollector
  ): Promise<GetPromptResult> {
    // Prompts have no helper-only semantics to preserve, so the leg goes
    // through the explicit-schema `requestWithSchema` seam directly — which
    // also exercises the modern per-request log-level `_meta` injection end to
    // end at the manager level.
    const sender: MrtrLegSender<GetPromptResult> = (req) =>
      this.runRetryableReadOperation(serverId, options, (client) =>
        client.requestWithSchema(
          req as Request,
          withInputRequired(defaultResultSchemaForMethod("prompts/get")),
          {
            ...this.withProgressHandler(serverId, options),
            allowInputRequired: true,
          }
        ) as Promise<GetPromptResult | InputRequiredResult>
      );

    return runInputRequiredOperation<GetPromptResult>({
      method: "prompts/get",
      params: params as Record<string, unknown>,
      sender,
      collectInput: collect,
      validateContent: this.mrtrElicitationContentValidator,
      supportedElicitationModes:
        this.mrtrSupportedElicitationModes(serverId),
      requestOptions: options,
      maxRounds: this.mrtrMaxRounds,
      signal: options?.signal,
    });
  }

  /**
   * Reconstructs upstream `callTool`'s output-schema assertion on the final
   * complete result of an MRTR tool call (the `requestWithSchema` leg path
   * bypasses it). Best-effort schema resolution: if the tool's `outputSchema`
   * cannot be looked up, a successful call is not failed.
   */
  private async validateToolOutputSchema(
    serverId: string,
    toolName: string,
    result: CallToolResult
  ): Promise<void> {
    const typed = result as CallToolResult & {
      structuredContent?: unknown;
      isError?: boolean;
    };
    let outputSchema: unknown;
    try {
      await this.ensureConnected(serverId);
      const client = this.getClientOrThrow(serverId);
      const list = await client.listTools();
      const tool = list.tools.find((candidate) => candidate.name === toolName) as
        | { outputSchema?: unknown }
        | undefined;
      outputSchema = tool?.outputSchema;
    } catch {
      return;
    }
    if (!outputSchema || typeof outputSchema !== "object") {
      return;
    }
    if (typed.isError) {
      return;
    }
    if (typed.structuredContent === undefined) {
      throw new TypeError(
        `Tool "${toolName}" has an output schema but did not return structured content.`
      );
    }
    const validate = this.mrtrToolOutputValidator.getValidator(
      outputSchema as JsonSchemaType
    );
    const validation = validate(typed.structuredContent);
    if (!validation.valid) {
      throw new TypeError(
        `Tool "${toolName}" structured content does not match its output schema: ${
          validation.errorMessage ?? "invalid"
        }.`
      );
    }
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
    const { signal, cleanup } = this.createRetrySignal(
      serverId,
      options?.signal
    );

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
      })().finally(() => {
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
