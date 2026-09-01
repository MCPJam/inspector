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
  NegotiationOutcomeLogger,
  ConfiguredNegotiationMode,
  Tool,
  AiSdkTool,
} from "./types.js";
import type { TraceContextProvider } from "./trace-context.js";
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
  MCPTasksWireError,
  isAuthError,
  isUnauthorized401,
  isInsufficientScopeError,
  unwrapEraNegotiationCause,
  classifyNegotiationFailureClass,
  readUnsupportedVersionFailure,
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
  wrapTransportForTaskResults,
  wrapTransportForFirstPageOnly,
  wrapTransportForDroppedListChanged,
  wrapFetchForNoListenChannel,
  wrapFetchForTaskRouting,
  TASK_CREATED_META_KEY,
  createDefaultRpcLogger,
} from "./transport-utils.js";
import {
  wrapFetchForHttpLogging,
  type HttpExchangeLogger,
} from "./http-exchange-log.js";
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
  resolveTasksWire,
  resolveTasksSupport,
  type TasksSupport,
  type TasksWire,
} from "./tasks-dispatch.js";
import {
  TasksExtNotificationMethod,
  canOpenTaskDeclaredListen,
  cancelTaskExt,
  getTaskExt,
  openTaskDeclaredListen,
  updateTaskExt,
  withTasksExtensionDeclaration,
} from "./tasks-ext.js";
import {
  resolveSkillsSupport,
  type SkillsSupport,
} from "./skills-dispatch.js";
import {
  getSkillExt,
  listSkillsExt,
  readResourceDirectoryExt,
} from "./skills-ext.js";
import { MCPSkillsWireError } from "./skills-ext-guards.js";
import type {
  SkillEntry,
  SkillsDirectoryReadResult,
  SkillsExtListResult,
} from "./skills-ext-types.js";
import type {
  McpSubscriptionHandle,
  SubscriptionFilterShape,
} from "./subscription-coordinator.js";
import {
  assertCreateTaskExtResult,
  parseTaskExtNotificationParams,
} from "./tasks-ext-guards.js";
import type {
  GetTaskExtResult,
  InputResponses as TaskExtInputResponses,
  UpdateTaskExtResult as TaskExtUpdateResult,
} from "./tasks-ext-types.js";
import {
  convertMCPToolsToVercelTools,
  type ToolSchemaOverrides,
} from "./tool-converters.js";
import {
  runToolTaskSeam,
  type ToolTaskSeamOptions,
} from "./tool-task-seam.js";
import { extensionTaskToObservation } from "./task-lifecycle-adapters.js";
import { MCP_ERROR_CODES } from "./mcp-error-codes.js";
import {
  buildMcpParamHeaders,
  scanXMcpHeaderDeclarations,
  stripXMcpHeaderAnnotations,
  type XMcpHeaderDeclaration,
} from "./mcp-header-mirror.js";
import type { ModelVisibleMcpToolResults } from "../host-config/types.js";
import {
  applyRuntimeClientCapabilities,
  getDefaultClientCapabilities,
  mergeClientCapabilities,
  normalizeClientCapabilities,
} from "./capabilities.js";
import {
  assertCallToolResult,
  isCreateTaskResult,
  LEGACY_TASK_AUGMENTED_RESULT_SCHEMA,
} from "./result-guards.js";
import { wrapLegacyClient } from "./managed-mcp-client-factory.js";
import { ObservableResponseCache } from "./observable-response-cache.js";
import { resolveVersionNegotiation } from "./version-negotiation.js";
import { DialectAwareJsonSchemaValidator } from "./dialect-aware-json-schema-validator.js";
import { createStrictElicitationContentValidator } from "./elicitation-content-validator.js";
import { isStatelessProtocolVersion } from "./mcp-protocol-version.js";
import {
  type ManagedMcpClient,
  ProtocolVersionPinUnsupported,
} from "./managed-mcp-client.js";
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
/**
 * The upstream `Tool` shape `CallToolRequestOptions.toolDefinition` accepts.
 * Derived from {@link ManagedMcpClient} rather than imported, so it tracks the
 * adapter's own surface instead of pinning a second name to the same type.
 */
/**
 * Whether an error means the caller's cancellation or DEADLINE fired, rather
 * than the lookup merely failing.
 *
 * Used by the best-effort schema lookups, which degrade on a miss but must not
 * swallow either: a cancelled call has to stay cancelled, and a call that blew
 * its timeout during the lookup must not then go on to issue the `tools/call`
 * the timeout was supposed to prevent.
 *
 * Covers all three shapes the deadline can arrive in — a DOM `AbortError` /
 * `TimeoutError`, a plain `Error` carrying those names, and the SDK's own
 * in-band `RequestTimeout` (-32001), which is what `ClientRequestOptions.timeout`
 * actually raises and is therefore the one most likely to be hit.
 */
function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError" || error.name === "TimeoutError";
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (
    code === MCP_ERROR_CODES.RequestTimeout ||
    code === MCP_ERROR_CODES.ConnectionClosed
  ) {
    return true;
  }
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/**
 * Keep the Streamable HTTP failure reachable on an error whose `cause` is
 * already the SSE failure. The two transports usually fail the same way, but
 * when they don't, `cause` alone silently discards half the story — including
 * the case where Streamable HTTP carried the auth challenge and SSE merely
 * timed out afterwards.
 *
 * Non-enumerable so it never widens a log line or a `JSON.stringify` of the
 * error. Both combined-failure throw sites go through here so neither can
 * drift away from the other.
 */
function attachStreamableCause<E extends Error>(
  error: E,
  streamableError: unknown
): E {
  if (streamableError !== undefined) {
    Object.defineProperty(error, "streamableCause", {
      value: streamableError,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return error;
}

type UpstreamToolDefinition = NonNullable<
  NonNullable<Parameters<ManagedMcpClient["callTool"]>[1]>["toolDefinition"]
>;

export class MCPClientManager {
  // State management
  private readonly registeredServers = new Map<string, RegisteredServerState>();
  private readonly liveClientStates = new Map<string, LiveClientState>();
  private readonly toolsMetadataCache = new Map<string, Map<string, any>>();
  private readonly toolsAnnotationsCache = new Map<
    string,
    Map<string, Record<string, unknown> | undefined>
  >();
  /**
   * Servers whose CURRENT connection has completed a no-`cursor`
   * `tools/list` — the only call that writes upstream's aggregated
   * `tools/list` response-cache entry, which is what upstream `callTool()`
   * reads to run SEP-2243 `Mcp-Param-*` header mirroring (see
   * `@modelcontextprotocol/client` `index.d.mts`: "Pass an explicit
   * `{ cursor }` to fetch a single page ... does not write the response
   * cache"). A membership miss means "mirroring would silently no-op", which
   * `ensureXMcpHeaderMirroringSource` repairs before a modern tools/call.
   *
   * Lifetime is the CONNECTION, not the server registration: the response
   * cache is allocated per upstream `Client`, so this is cleared everywhere
   * `toolsMetadataCache` is (every live-state teardown) and never persists
   * across a reconnect.
   */
  private readonly aggregatedToolsListWarmed = new Set<string>();
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
   * request's `requestedSchema` (§12.1.11). The rule itself lives in
   * `elicitation-content-validator.ts` so task input drivers wire the same
   * authority; see that module for the strictness rationale.
   */
  private readonly mrtrElicitationContentValidator: ElicitationContentValidator =
    createStrictElicitationContentValidator();

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
  private readonly defaultHttpLogger?: HttpExchangeLogger;
  /** See `baseFetch` on `MCPClientManagerOptions`. */
  private readonly defaultBaseFetch?: typeof fetch;
  private readonly defaultProgressHandler?: ProgressHandler;
  private readonly cacheEventLogger?: CacheEventLogger;
  /**
   * Optional accessor for the ambient OpenTelemetry trace context to
   * propagate. Unset by default — MCPJam runs no tracer, so no
   * `traceparent`/`tracestate`/`baggage` `_meta` key is ever emitted.
   */
  private readonly traceContextProvider?: TraceContextProvider;
  private readonly negotiationOutcomeLogger?: NegotiationOutcomeLogger;
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
    this.defaultHttpLogger = options.httpLogger;
    this.defaultBaseFetch = options.baseFetch;
    this.defaultProgressHandler = options.progressHandler;
    this.cacheEventLogger = options.cacheEventLogger;
    this.traceContextProvider = options.traceContextProvider;
    this.negotiationOutcomeLogger = options.negotiationOutcomeLogger;
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
        // Fire-and-forget prefetch: a failure here is NOT lost — the failed
        // attempt clears its live state, so the first operation that needs
        // this server re-attempts the connect and observes the error itself
        // (in-flight attempts are deduped via retryPromise/connectPromise).
        // Without the catch, every failed eager connect ALSO escapes as a
        // process-level unhandledRejection.
        this.connectToServer(id, config).catch(() => {});
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
  getNegotiatedProtocolVersion(serverId: string): string | undefined {
    return this.liveClientStates
      .get(serverId)
      ?.client?.getNegotiatedProtocolVersion?.();
  }

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
      // Report the transport that ACTUALLY connected, not the one the config
      // asked for. Deriving this from `config` is wrong in both directions:
      // a declared streamable-http server at a `/sse` path reads as "sse"
      // though it ran over Streamable HTTP, and a connection that fell back
      // to SSE reads as "streamable-http" — the transport that failed. This
      // value feeds snapshots, conformance output and hosted trace metadata,
      // so it has to describe the live connection. The config heuristic
      // stays only as the pre-connect fallback.
      const activeTransport = liveState?.transport;
      if (activeTransport instanceof SSEClientTransport) {
        transportType = "sse";
      } else if (activeTransport instanceof StreamableHTTPClientTransport) {
        transportType = "streamable-http";
      } else {
        const url = new URL(config.url);
        transportType = (config.preferSSE ?? url.pathname.endsWith("/sse"))
          ? "sse"
          : "streamable-http";
      }
    }

    // Public negotiated-version accessor (upstream
    // `Client.getNegotiatedProtocolVersion()`), never the private
    // `transport._protocolVersion`.
    const protocolVersion = client.getNegotiatedProtocolVersion?.();

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
      const client = await retryPromise;
      this.emitNegotiationOutcome(serverId, config, "connected", undefined);
      return client;
    } catch (error) {
      this.emitNegotiationOutcome(serverId, config, "failed", error);
      throw error;
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
   * Emit one auto-negotiation telemetry event for a completed connection
   * attempt. Fires only when a `negotiationOutcomeLogger` is wired, and NEVER
   * throws into the connect path (a telemetry failure must not break a
   * connection). Carries no request payloads.
   */
  private emitNegotiationOutcome(
    serverId: string,
    config: MCPServerConfig,
    outcome: "connected" | "failed",
    error: unknown
  ): void {
    const logger = this.negotiationOutcomeLogger;
    if (!logger) {
      return;
    }
    try {
      const transport: "http" | "stdio" = this.isStdioConfig(config)
        ? "stdio"
        : "http";
      const resolvedPin = this.isStdioConfig(config)
        ? undefined
        : config.mcpProtocolVersion;
      const negotiation = resolveVersionNegotiation(resolvedPin);
      const configuredMode: ConfiguredNegotiationMode =
        negotiation === undefined
          ? "legacy"
          : negotiation.mode === "auto"
            ? "auto"
            : "modern-pin";

      let negotiatedEra: "legacy" | "modern" | undefined;
      let negotiatedProtocolVersion: string | undefined;
      let failureClass: string | undefined;
      if (outcome === "connected") {
        negotiatedProtocolVersion =
          this.getInitializationInfo(serverId)?.protocolVersion;
        negotiatedEra = this.getManagedClient(serverId)?.getProtocolEra?.();
      } else {
        // Unwrap an auto-probe `SdkError(EraNegotiationFailed)` so the class
        // reported is the real transport error (e.g. `UnauthorizedError`),
        // not the opaque negotiation wrapper.
        failureClass = classifyNegotiationFailureClass(
          unwrapEraNegotiationCause(error)
        );
      }

      logger({
        serverId,
        transport,
        configuredMode,
        outcome,
        ...(negotiatedEra !== undefined ? { negotiatedEra } : {}),
        ...(negotiatedProtocolVersion !== undefined
          ? { negotiatedProtocolVersion }
          : {}),
        ...(failureClass !== undefined ? { failureClass } : {}),
      });
    } catch {
      // Telemetry must never disturb connection control flow.
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
    this.toolsAnnotationsCache.delete(serverId);
    this.aggregatedToolsListWarmed.delete(serverId);
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
   *
   * A call with no `cursor` (the common case) auto-aggregates every page in
   * the upstream client AND writes that aggregate to its response cache — the
   * view upstream `callTool()` reads for SEP-2243 `Mcp-Param-*` mirroring. An
   * explicit-`{ cursor }` page walk deliberately writes neither, and
   * `cacheMode: "bypass"` returns the aggregate without writing it, so only a
   * no-`cursor` non-bypass call marks the connection warm here.
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
        if (params?.cursor === undefined && options?.cacheMode !== "bypass") {
          this.aggregatedToolsListWarmed.add(serverId);
        }
        return result;
      } catch (error) {
        if (isMethodUnavailableError(error, "tools/list")) {
          this.toolsMetadataCache.set(serverId, new Map());
          this.toolsAnnotationsCache.set(serverId, new Map());
          // A server without `tools/list` cannot declare `x-mcp-header` on
          // anything, so the mirroring source is trivially complete.
          this.aggregatedToolsListWarmed.add(serverId);
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
   * Gets annotations for all tools from the most recent cached tools/list.
   */
  getAllToolAnnotations(
    serverId: string
  ): Record<string, Record<string, unknown> | undefined> {
    const annotationsMap = this.toolsAnnotationsCache.get(serverId);
    return annotationsMap ? Object.fromEntries(annotationsMap) : {};
  }

  /**
   * Whether a complete tools/list response has populated the annotation cache.
   * An empty map is still a valid populated response for a server with no
   * tools; callers must distinguish that from a cold or invalidated cache.
   */
  hasCachedToolAnnotations(serverId: string): boolean {
    return this.toolsAnnotationsCache.has(serverId);
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
      /**
       * Task policy for the tool calls this set produces. Omit (the default)
       * and every call takes the pre-existing path, byte-for-byte: no `_meta`,
       * no declaration, no extra request field. See `tool-task-seam.ts`.
       *
       * The mode is resolved by the CALLER — this class must not read host
       * configs. `off` is expressed by omitting the option entirely, which is
       * what `toolTaskSeamOptionsFor` returns for it.
       */
      tasks?: ToolTaskSeamOptions;
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
              const { requestOptions, settle } = this.applyCancellationPolicy(
                id,
                readOptions?.abortSignal
              );
              return settle(this.readResource(id, { uri }, requestOptions));
            },
            callTool: async ({ name, args, options: callOptions }) => {
              const { requestOptions, settle } = this.applyCancellationPolicy(
                id,
                callOptions?.abortSignal
              );
              const toolArgs = (args ?? {}) as ExecuteToolArguments;
              if (!options.tasks) {
                const result = await settle(
                  this.executeTool(id, name, toolArgs, requestOptions)
                );
                return assertCallToolResult(result, `Tool "${name}" result`);
              }
              // `id` is captured per server, so the wire is resolved per call:
              // a mixed tool set does the right thing for each server without
              // any caller knowing mixed sets exist.
              //
              // The whole seam is settled, not just its first leg: a task-wire
              // call polls across several requests, and a host that cancels
              // nothing must abandon the polling loop locally rather than
              // cancel any one leg on the wire.
              return settle(
                runToolTaskSeam(
                  {
                    serverId: id,
                    toolName: name,
                    wire: this.getTasksSupport(id).wire,
                    callPlain: () =>
                      this.executeTool(id, name, toolArgs, requestOptions),
                    callEligible: () =>
                      this.executeTool(id, name, toolArgs, {
                        ...(requestOptions ? { request: requestOptions } : {}),
                        allowTaskResult: true,
                      }),
                    getTask: async (taskId) =>
                      extensionTaskToObservation(
                        await this.getTaskExt(id, taskId, requestOptions)
                      ),
                    updateTask: async (taskId, inputResponses) => {
                      // The await driver is wire-neutral and types responses as
                      // plain JSON; on this branch the wire is known to be the
                      // extension, whose `InputResponses` is the narrower shape
                      // `collectTaskInputResponses` already validated against.
                      await this.updateTask(
                        id,
                        taskId,
                        inputResponses as TaskExtInputResponses,
                        requestOptions
                      );
                    },
                  },
                  options.tasks
                )
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

    // Modern multi-round-trip: when a collector is registered and this is not a
    // task-augmented call, drive the manual `input_required` loop. A complete
    // result on the first leg exits immediately, so legacy servers are
    // unaffected.
    const mrtrCollect = this.resolveMrtrCollector(serverId);
    if (mrtrCollect && request.task === undefined) {
      // One result state machine: an extension-eligible call goes through the
      // SAME MRTR loop, because `resultType` is a tri-state — a call may run
      // `input_required` rounds and only THEN resolve to a task. The task
      // envelope is unwrapped from whatever the loop terminates with.
      const mrtrResult = await this.executeToolWithInputRequired(
        serverId,
        { name: toolName, arguments: args },
        request,
        mrtrCollect
      );
      return (
        this.unwrapCreatedTaskExt(serverId, request, mrtrResult) ?? mrtrResult
      );
    }

    const operation = async (signal?: AbortSignal) => {
      await this.ensureConnected(serverId, signal);
      const client = this.getClientOrThrow(serverId);
      const mergedOptions = this.withProgressHandler(serverId, request.request);
      const callParams = this.withTaskEligibilityDeclaration(serverId, request, {
        name: toolName,
        arguments: args,
      });

      if (request.task !== undefined) {
        this.assertLegacyTasksWire(serverId);
        const taskValue =
          request.task.ttl !== undefined ? { ttl: request.task.ttl } : {};
        // 2025-11-25 puts the task opt-in in request **params**, not in
        // `RequestOptions` (beta.4 never carried it there — the options-based
        // form silently degraded to a plain `tools/call`).
        //
        // The response is a `CreateTaskResult`, which beta.4's built-in
        // `tools/call` result schema rejects (it demands `content`), so the
        // task-augmented call goes through the explicit-schema seam with a
        // permissive schema and is validated by `isCreateTaskResult` below.
        const result = await client.requestWithSchema(
          {
            method: "tools/call",
            params: { ...callParams, task: taskValue },
          },
          LEGACY_TASK_AUGMENTED_RESULT_SCHEMA,
          mergedOptions
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

      // Signal + timeout only: the schema lookup must honor the caller's abort
      // and deadline, but must NOT inherit the call's progress handler (a
      // `tools/list` is not the operation the caller is tracking).
      const schemaLookupOptions = {
        ...(signal ? { signal } : {}),
        ...(request.request?.timeout !== undefined
          ? { timeout: request.request.timeout }
          : {}),
      };
      // `mirrorToolParamHeaders: false` (host config `toolParamHeaderMirroring:
      // "omit"`) simulates a client that never sends `Mcp-Param-*`. Upstream
      // `callTool` mirrors internally with no disable knob, so the suppression
      // rides the one seam it honors — a `toolDefinition` whose `x-mcp-header`
      // annotations are stripped.
      const unmirroredToolDefinition = this.xMcpMirroringDisabled(serverId)
        ? await this.resolveUnmirroredToolDefinition(
            serverId,
            client,
            toolName,
            schemaLookupOptions
          )
        : undefined;
      if (!this.xMcpMirroringDisabled(serverId)) {
        await this.ensureXMcpHeaderMirroringSource(
          serverId,
          client,
          schemaLookupOptions
        );
      }

      const plainResult = await this.withElicitationTimeoutSuspension(
        serverId,
        mergedOptions,
        (callOptions) =>
          client.callTool(
            callParams,
            unmirroredToolDefinition
              ? { ...callOptions, toolDefinition: unmirroredToolDefinition }
              : callOptions
          )
      );
      return (
        this.unwrapCreatedTaskExt(serverId, request, plainResult) ?? plainResult
      );
    };

    return this.runRetriedOperation(
      serverId,
      request.request,
      request.retry ?? { retries: 0, retryDelayMs: 0 },
      operation
    );
  }

  /**
   * Guarantees upstream `callTool()` can run SEP-2243 `Mcp-Param-*` header
   * mirroring (2026-07-28 Streamable HTTP, "clients **MUST** mirror the
   * designated parameter values into HTTP headers").
   *
   * Upstream reads the tool's `inputSchema` from exactly two places: the
   * `CallToolRequestOptions.toolDefinition` escape hatch, or the aggregated
   * `tools/list` entry in its response cache. MCPJam passes the former
   * nowhere, and several surfaces reach `executeTool` with a cache that was
   * never written — a hosted/CLI ephemeral connection that only ever calls
   * the tool, and any surface that walks pagination by hand (an
   * explicit-`{ cursor }` `listTools()` does not write the cache). Upstream's
   * miss path is silent: it sends the call with no `Mcp-Param-*` headers and
   * relies on the server answering `HEADER_MISMATCH` to trigger its
   * evict-refetch-retry recovery — which a lenient server never does. So the
   * MUST was being skipped with no warning.
   *
   * The repair is to WARM the source rather than to synthesize a
   * `toolDefinition`: upstream then keeps ownership of freshness, of the
   * `list_changed` eviction lifecycle, and of the `HEADER_MISMATCH` recovery
   * retry (which it disables outright when `toolDefinition` is supplied), and
   * output-schema validation keeps reading the same view it does today. On
   * the surfaces that DO hold the tool definitions, they hold them because
   * they called {@link listTools} on this manager — which already warmed the
   * cache — so those paths pay nothing here.
   *
   * Three gates keep this off every path that cannot need it, so no legacy
   * (2025-*) connection changes by a single byte:
   * - already warmed on this connection (tracked by
   *   `aggregatedToolsListWarmed`) — the common case, zero round trips;
   * - era is not `"modern"`, or is unknown (an adapter that cannot report it)
   *   — mirroring is 2026-07-28-only and an unknown era fails closed;
   * - the transport is stdio — mirroring is Streamable-HTTP-only, and unlike
   *   upstream (which cannot tell an HTTP transport from an in-memory one) we
   *   own the server config and can skip the useless round trip.
   *
   * A failed warm-up is NOT marked warm and NOT fatal: the tool call proceeds
   * exactly as it does today (upstream's `HEADER_MISMATCH` recovery is still
   * armed because we pass no `toolDefinition`), and the next call re-attempts
   * the warm-up rather than disabling mirroring for the connection's life.
   */
  private async ensureXMcpHeaderMirroringSource(
    serverId: string,
    client: ManagedMcpClient,
    options: Pick<ClientRequestOptions, "signal" | "timeout">
  ): Promise<void> {
    if (this.aggregatedToolsListWarmed.has(serverId)) return;
    if (client.getProtocolEra?.() !== "modern") return;
    const config = this.registeredServers.get(serverId)?.config;
    if (!config || this.isStdioConfig(config)) return;

    try {
      // No `cursor`, no `cacheMode` override: the one call shape that writes
      // upstream's aggregated `tools/list` entry. Marks the connection warm
      // via `listTools` itself, so this runs at most once per connection.
      await this.listTools(serverId, undefined, options);
    } catch {
      // Deliberately swallowed — see the docblock. A `tools/list` failure must
      // not convert an otherwise-valid `tools/call` into an error.
    }
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
    const mrtrCollect = this.resolveMrtrCollector(serverId);
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
    const mrtrCollect = this.resolveMrtrCollector(serverId);
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
   * Pings a server to check connectivity — era-aware.
   *
   * `ping` was removed from the 2026-07-28 vocabulary, so the upstream
   * client refuses to send it on a modern-classified connection
   * (`MethodNotSupportedByProtocolVersion`). The modern era's universally
   * available request is `server/discover`, so that is the liveness probe
   * there; its result is discarded and the ping contract's `EmptyResult`
   * returned, so callers stay era-agnostic. Legacy connections keep the
   * wire-identical `ping`.
   */
  async pingServer(
    serverId: string,
    options?: RequestOptions
  ): Promise<Awaited<ReturnType<Client["ping"]>>> {
    return this.runRetryableReadOperation(serverId, options, async (client) => {
      if (client.getProtocolEra?.() === "modern" && client.discover) {
        await client.discover(options);
        return {} as Awaited<ReturnType<Client["ping"]>>;
      }
      return client.ping(options);
    });
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
    // Both wires feed the same handler: legacy `notifications/tasks/status`
    // (2025-11-25) and the extension's `notifications/tasks` (SEP-2663).
    // Callers tag by wire via `getTasksSupport(serverId).wire`.
    this.addNotificationHandler(
      serverId,
      TaskStatusNotificationMethod,
      (notification) => {
        if (this.getTasksWire(serverId) !== "legacy") return;
        handler(notification);
      }
    );
    this.addNotificationHandler(
      serverId,
      TasksExtNotificationMethod,
      (notification) => {
        // Untrusted body: only a valid `DetailedTask` reaches the handler, and
        // only on a connection that actually negotiated the extension.
        if (this.getTasksWire(serverId) !== "extension") return;
        const params = parseTaskExtNotificationParams(
          (notification as { params?: unknown }).params
        );
        if (!params) return;
        handler(notification);
      }
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
   *
   * Like {@link setMrtrInputCollector}, this is intentionally NOT gated on
   * prior registration. The two are registered together before connect (an
   * interactive surface answers `elicitation/create` on both eras, so both
   * deliveries have to be armed on the same envelope), and a gate here made
   * that pairing throw `Unknown MCP server` for every caller that registered
   * ahead of `connectToServer` — which is the only point at which `elicitation`
   * can still reach the connect envelope. Registering for an as-yet-unknown
   * server is a no-op until that server connects; the live-client update below
   * is already conditional on there being one.
   */
  setElicitationHandler(serverId: string, handler: ElicitationHandler): void {
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
    if (this.getTasksWire(serverId) === "extension") {
      // SEP-2663 has no `tasks/list`: the client's tracker IS the list. Answer
      // locally so callers can stay wire-agnostic (no network round trip).
      return { tasks: [] };
    }
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
    // Legacy-form reads carry no per-request extension declaration, so a
    // conforming extension server MUST answer `-32021`: refuse locally instead
    // and send nothing (callers dispatch on `getTasksWire`).
    this.assertLegacyTasksReadWire(serverId, "tasks/get");
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
    if (this.getTasksWire(serverId) === "extension") {
      throw new MCPTasksWireError(
        `Server "${serverId}" speaks the io.modelcontextprotocol/tasks extension, which has no tasks/result; use getTaskExt() — a completed task carries its result inline.`,
        "extension"
      );
    }
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
    this.assertLegacyTasksReadWire(serverId, "tasks/cancel");
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);
    return tasksCancelTask(client, taskId, this.withTimeout(serverId, options));
  }

  /**
   * The tasks wire this connection speaks (`"none"` when tasks are not
   * available on the negotiated version / advertised capabilities).
   */
  getTasksWire(serverId: string): TasksWire {
    return resolveTasksWire(
      this.getNegotiatedProtocolVersion(serverId),
      this.getServerCapabilities(serverId)
    );
  }

  /**
   * Checks if server supports task-augmented tool calls (legacy wire only).
   */
  supportsTasksForToolCalls(serverId: string): boolean {
    return (
      this.getTasksWire(serverId) === "legacy" &&
      supportsTasksForToolCalls(this.getServerCapabilities(serverId))
    );
  }

  /**
   * Checks if server supports listing tasks (legacy wire only).
   */
  supportsTasksList(serverId: string): boolean {
    return (
      this.getTasksWire(serverId) === "legacy" &&
      supportsTasksList(this.getServerCapabilities(serverId))
    );
  }

  /**
   * Checks if server supports canceling tasks (legacy wire only).
   */
  supportsTasksCancel(serverId: string): boolean {
    return (
      this.getTasksWire(serverId) === "legacy" &&
      supportsTasksCancel(this.getServerCapabilities(serverId))
    );
  }

  /**
   * The full tasks support matrix for a connection — the single value every
   * route, UI, and CLI surface should branch on.
   */
  getTasksSupport(serverId: string): TasksSupport {
    return resolveTasksSupport(
      this.getNegotiatedProtocolVersion(serverId),
      this.getServerCapabilities(serverId)
    );
  }

  /**
   * `tasks/get` on the SEP-2663 extension wire. A completed task carries its
   * `result` inline; an expired/unknown task raises the server's `-32602`.
   */
  async getTaskExt(
    serverId: string,
    taskId: string,
    options?: ClientRequestOptions
  ): Promise<GetTaskExtResult> {
    return this.runRetryableReadOperation(serverId, options, (client) => {
      this.assertExtensionTasksWire(serverId, "tasks/get");
      return getTaskExt(
        {
          client,
          declaredCapabilities: this.declaredCapabilitiesFor(serverId),
          options: this.withTimeout(serverId, options),
        },
        taskId
      );
    });
  }

  /**
   * `tasks/update` — submit (possibly partial) `inputResponses`. Resolves with
   * the spec's empty acknowledgement: re-poll `getTaskExt` for the new status.
   */
  async updateTask(
    serverId: string,
    taskId: string,
    inputResponses: TaskExtInputResponses,
    options?: ClientRequestOptions
  ): Promise<TaskExtUpdateResult> {
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);
    this.assertExtensionTasksWire(serverId, "tasks/update");
    return updateTaskExt(
      {
        client,
        declaredCapabilities: this.declaredCapabilitiesFor(serverId),
        options: this.withTimeout(serverId, options),
      },
      taskId,
      inputResponses
    );
  }

  /**
   * `tasks/cancel` on the extension wire. The result is an EMPTY ack:
   * cancellation is cooperative, so callers must re-poll rather than render
   * the ack as a state.
   */
  async cancelTaskExt(
    serverId: string,
    taskId: string,
    options?: ClientRequestOptions
  ): Promise<Record<string, unknown>> {
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);
    this.assertExtensionTasksWire(serverId, "tasks/cancel");
    return cancelTaskExt(
      {
        client,
        declaredCapabilities: this.declaredCapabilitiesFor(serverId),
        options: this.withTimeout(serverId, options),
      },
      taskId
    );
  }

  /**
   * Opens a task-filtered `subscriptions/listen` carrying the extension's
   * per-request eligibility declaration (SEP-2663). A non-declaring
   * task-filtered listen MUST be answered `-32021`, so this is the ONLY way a
   * `taskIds` filter may reach the wire.
   *
   * Port contract: on `SubscriptionClientPort`, availability is expressed by
   * method PRESENCE — callers probe {@link supportsTaskDeclaredListen} and
   * install this method onto the port only when it answers true. A defined
   * method must therefore never answer `undefined`; when the underlying seam
   * is unavailable despite the probe, this throws instead of silently sending
   * nothing.
   *
   * `TasksExtListenMetaSeamError` propagates deliberately: the coordinator
   * records the failed open on the stream record and polling continues —
   * task notifications are OPTIONAL, so nothing is lost but latency.
   */
  async listenWithTasksDeclaration(
    serverId: string,
    filter: SubscriptionFilterShape
  ): Promise<McpSubscriptionHandle> {
    await this.ensureConnected(serverId);
    const client = this.getClientOrThrow(serverId);
    this.assertExtensionTasksWire(
      serverId,
      "a task-filtered subscriptions/listen"
    );
    const handle = await openTaskDeclaredListen(
      {
        client,
        declaredCapabilities: this.declaredCapabilitiesFor(serverId),
      },
      filter as Record<string, unknown>
    );
    if (handle === undefined) {
      throw new Error(
        `Server "${serverId}"'s connection cannot open a task-declared ` +
          `subscriptions/listen (no listen method, or no upstream client ` +
          `behind the managed client). Probe supportsTaskDeclaredListen() ` +
          `before calling; polling via tasks/get remains sufficient.`
      );
    }
    return handle as McpSubscriptionHandle;
  }

  /**
   * Whether {@link listenWithTasksDeclaration} can put a declared,
   * task-filtered listen on this connection's wire: extension tasks wire ∧
   * the client can listen ∧ the listen-meta seam target resolves. Consumers
   * building a `SubscriptionClientPort` install the opener onto the port only
   * when this answers true — absence of the method IS the coordinator's signal
   * to drop `taskIds` (recording `tasks-declaration-unavailable`) and keep
   * polling.
   */
  supportsTaskDeclaredListen(serverId: string): boolean {
    if (this.getTasksWire(serverId) !== "extension") return false;
    const client = this.liveClientStates.get(serverId)?.client;
    if (!client) return false;
    return canOpenTaskDeclaredListen(client);
  }

  // ---------------------------------------------------------------------
  // io.modelcontextprotocol/skills (SEP-2640)
  // ---------------------------------------------------------------------

  /**
   * The skills support matrix for a connection — the single value every
   * route, UI, CLI, and chat surface branches on.
   *
   * `active` is a CONJUNCTION: this client advertised the extension AND the
   * server declared it. Both halves are read from what actually happened on
   * this connection (the initialized client capabilities, the server's
   * initialize result), so the answer can never disagree with the wire.
   */
  getSkillsSupport(serverId: string): SkillsSupport {
    return resolveSkillsSupport(
      this.declaredCapabilitiesFor(serverId),
      this.getServerCapabilities(serverId)
    );
  }

  /**
   * {@link getSkillsSupport}, after ensuring the connection exists.
   *
   * `getSkillsSupport` reads what a LIVE connection negotiated, synchronously.
   * On a manager whose connection has not been established yet it therefore
   * answers `active: false` for every server — not because the extension is
   * absent, but because there is nothing to read. That is the right answer to
   * the question it was asked and the wrong answer to the question a caller
   * usually means.
   *
   * It matters on EPHEMERAL managers, which is every hosted request: a route
   * that reads support as its first act reads it before anything has
   * connected, concludes the extension is inactive, and returns an empty
   * listing — then tears the manager down, aborting the negotiation that was
   * still in flight. The symptom is a 200 with no skills and an `AbortError`
   * in the connection telemetry, on a server that is perfectly reachable.
   *
   * Every other capability question reaches the wire through a method that
   * awaits `ensureConnected` first. This is that method for skills.
   */
  async ensureSkillsSupport(serverId: string): Promise<SkillsSupport> {
    await this.ensureConnected(serverId);
    return this.getSkillsSupport(serverId);
  }

  /**
   * Advertise = enforce. A `skills/*` request is refused BEFORE it reaches the
   * wire whenever the extension is not mutually declared.
   *
   * Typed, not a bare `Error`: routes map `isMCPSkillsWireError` onto a
   * permanent 400 rather than a 500 that hosted clients would retry against a
   * server that can never answer.
   */
  private assertSkillsActive(serverId: string, method: string): void {
    const support = this.getSkillsSupport(serverId);
    if (!support.active) {
      throw new MCPSkillsWireError({
        method,
        serverId,
        advertised: support.advertised,
        declared: support.declared,
      });
    }
  }

  /**
   * `skills/list` — one page. Drain with `listAllServerSkills` in
   * `operations.ts` rather than looping here.
   *
   * A listing MAY be empty or partial by spec: absence from it is never proof
   * a skill does not exist. Confirm disappearance with {@link getServerSkill}.
   */
  async listServerSkills(
    serverId: string,
    params?: { cursor?: string },
    options?: ClientRequestOptions
  ): Promise<SkillsExtListResult> {
    return this.runRetryableReadOperation(serverId, options, (client) => {
      this.assertSkillsActive(serverId, "skills/list");
      return listSkillsExt(
        { client, options: this.withTimeout(serverId, options) },
        params
      );
    });
  }

  /**
   * `skills/get` — one skill by URI, including skills the listing never
   * mentioned. A conforming server answers `-32602` for a URI it does not
   * serve (`isSkillNotFoundError`).
   */
  async getServerSkill(
    serverId: string,
    uri: string,
    options?: ClientRequestOptions
  ): Promise<SkillEntry> {
    return this.runRetryableReadOperation(serverId, options, (client) => {
      this.assertSkillsActive(serverId, "skills/get");
      return getSkillExt(
        { client, options: this.withTimeout(serverId, options) },
        uri
      );
    });
  }

  /**
   * `resources/directory/read` — the OPTIONAL readdir, gated on the server's
   * `{ directoryRead: true }` setting on TOP of the mutual declaration. The
   * extra gate is not redundant: a server may speak skills without opting into
   * directory reads, and sending the method anyway is an undeclared probe.
   */
  async readServerResourceDirectory(
    serverId: string,
    params: { uri: string; cursor?: string },
    options?: ClientRequestOptions
  ): Promise<SkillsDirectoryReadResult> {
    return this.runRetryableReadOperation(serverId, options, (client) => {
      this.assertSkillsActive(serverId, "resources/directory/read");
      if (!this.getSkillsSupport(serverId).directoryRead) {
        throw new MCPSkillsWireError({
          method: "resources/directory/read",
          serverId,
          advertised: true,
          // The extension IS declared; what is missing is the optional
          // `directoryRead` opt-in. Both booleans stay TRUTHFUL — they are
          // public facts about the connection — and `missingSetting` is what
          // makes the message name the actual refusal.
          declared: true,
          missingSetting: "directoryRead",
        });
      }
      return readResourceDirectoryExt(
        { client, options: this.withTimeout(serverId, options) },
        params
      );
    });
  }

  private declaredCapabilitiesFor(
    serverId: string
  ): ClientCapabilityOptions | undefined {
    return this.liveClientStates.get(serverId)?.initializedClientCapabilities;
  }

  private assertExtensionTasksWire(serverId: string, method: string): void {
    const wire = this.getTasksWire(serverId);
    if (wire !== "extension") {
      // Typed, NOT a bare TypeError: routes map `isMCPTasksWireError` onto a
      // 400 `TASKS_UNSUPPORTED` (a permanent, non-retryable condition). A
      // TypeError becomes a 500, which hosted clients treat as transient and
      // retry forever against a server that can never serve the request.
      throw new MCPTasksWireError(
        `Server "${serverId}" does not speak the io.modelcontextprotocol/tasks extension (resolved wire: "${wire}"); refusing to send ${method}.`,
        wire
      );
    }
  }

  /**
   * Adds the per-request extension declaration when this call is eligible for
   * a task result. Sends nothing extra on the legacy/none wires; a task
   * request on `wire: "none"` is a local typed error (never a wire probe).
   */
  private withTaskEligibilityDeclaration<T extends Record<string, unknown>>(
    serverId: string,
    request: ExecuteToolRequest,
    callParams: T
  ): T {
    if (request.allowTaskResult !== true || request.task !== undefined) {
      return callParams;
    }
    const wire = this.getTasksWire(serverId);
    if (wire === "extension") {
      return withTasksExtensionDeclaration(
        callParams,
        this.declaredCapabilitiesFor(serverId)
      );
    }
    if (wire === "legacy") {
      // The legacy wire has no per-request declaration; the caller opts in via
      // `task: {ttl?}` instead. Nothing to add.
      return callParams;
    }
    throw new MCPTasksWireError(
      `Server "${serverId}" has no tasks wire (resolved wire: "none"); refusing to declare task eligibility on tools/call.`,
      wire
    );
  }

  /**
   * Unwraps a `CreateTaskResult` that the transport wrapper smuggled through
   * beta.4's decoder (see `wrapTransportForTaskResults`). Returns `undefined`
   * for an ordinary result — the server decides, and a non-task result is
   * always valid on the extension wire.
   */
  private unwrapCreatedTaskExt(
    serverId: string,
    request: ExecuteToolRequest,
    result: unknown
  ): Record<string, unknown> | undefined {
    // Gate: only a call that declared task eligibility on the extension wire
    // can yield a task. Without this, any server on any version could write the
    // smuggling key into an ordinary result and fabricate a task envelope.
    if (
      request.allowTaskResult !== true ||
      this.getTasksWire(serverId) !== "extension"
    ) {
      return undefined;
    }
    const meta = (result as { _meta?: Record<string, unknown> } | undefined)
      ?._meta;
    const raw = meta?.[TASK_CREATED_META_KEY];
    if (raw === undefined) {
      return undefined;
    }
    // The server's own `_meta` is preserved verbatim — SEP-2663 has no
    // `model-immediate-response` concept, so nothing is synthesized here.
    return { ...assertCreateTaskExtResult(raw) } as Record<string, unknown>;
  }

  /** Guards the legacy-form `tasks/*` read methods against other wires. */
  private assertLegacyTasksReadWire(serverId: string, method: string): void {
    const wire = this.getTasksWire(serverId);
    if (wire !== "legacy") {
      throw new MCPTasksWireError(
        `Server "${serverId}" does not speak the 2025-11-25 tasks wire (resolved wire: "${wire}"); refusing to send a legacy-form ${method}.`,
        wire
      );
    }
  }

  private assertLegacyTasksWire(serverId: string): void {
    const wire = this.getTasksWire(serverId);
    if (wire !== "legacy") {
      throw new MCPTasksWireError(
        `Server "${serverId}" does not speak the 2025-11-25 tasks wire (resolved wire: "${wire}"); refusing to send a task-augmented tools/call.`,
        wire
      );
    }
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
    // Mark handled without affecting awaiters (they hold the original
    // promise): awaitWithAbort abandons connectionPromise when the caller's
    // signal fires first, and an abandoned rejection escapes as a
    // process-level unhandledRejection.
    connectionPromise.catch(() => {});
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
      // stdio configs never carry a pin (`mcpProtocolVersion` is HTTP-only,
      // and the UI does not expose a modern stdio pin), so the stdio pin is
      // always undefined. HTTP keeps its per-server pin.
      const resolvedProtocolVersion = this.isStdioConfig(config)
        ? undefined
        : config.mcpProtocolVersion;
      const wantsStateless =
        resolvedProtocolVersion !== undefined &&
        isStatelessProtocolVersion(resolvedProtocolVersion);
      // Resolve negotiation before the legacy initialize accept-list so Auto
      // has one source of truth. An unpinned connection probes the modern era
      // first and, on a legacy signal, must fall back with the upstream SDK's
      // complete built-in supported-version list. Forwarding a persisted
      // per-server or manager-default list here can make the first connection
      // succeed but a later reconnect reject the server's valid counter-offer.
      const versionNegotiation = resolveVersionNegotiation(
        resolvedProtocolVersion
      );
      const wantsAutoNegotiation = versionNegotiation?.mode === "auto";
      // Stateful `mcpProtocolVersion` pin (e.g. `"2025-11-25"`) propagates
      // into the legacy `Client`'s `supportedProtocolVersions` accept-list
      // so `initialize.params.protocolVersion` actually goes out as the
      // pinned value rather than the SDK's built-in newest default. An
      // explicit `supportedProtocolVersions` (per-server or default) still
      // wins for an explicit pin — pinning at one layer while overriding the
      // other would be ambiguous and the override is the more specific signal.
      // Auto deliberately ignores both lists so its legacy fallback negotiates
      // against every version supported by the upstream SDK.
      const resolvedSupportedProtocolVersions = wantsAutoNegotiation
        ? undefined
        : config.supportedProtocolVersions ??
          this.defaultSupportedProtocolVersions ??
          (!wantsStateless && resolvedProtocolVersion !== undefined
            ? [resolvedProtocolVersion]
            : undefined);
      // Send the version that was actually PINNED, not whatever happens to
      // sit at index 0 of the accept-list.
      //
      // The two fields answer different questions: the list is what this
      // client can speak, the pin is which of those it proposes. Upstream
      // `Client` reads only `supportedProtocolVersions[0]` as
      // `initialize.params.protocolVersion`, so honoring the pin means
      // hoisting it — previously an explicit list silently discarded the pin
      // and connected as its first entry, i.e. a user could pin 2025-06-18
      // and watch 2025-11-25 go out on the wire.
      //
      // Hoisting rather than collapsing to `[pin]` keeps the remaining
      // entries as fallbacks, so a client advertising several versions still
      // accepts the server's counter-offer. Relative order of the rest is
      // preserved — it is semantic.
      //
      // A pin absent from the list is left alone: it would put a version on
      // the wire the client never claimed to speak. `canonicalizeMcpProfile`
      // rejects that combination for stateful host pins anyway, so this only
      // guards hand-built configs.
      const supportedProtocolVersions =
        !wantsStateless &&
        resolvedProtocolVersion !== undefined &&
        resolvedSupportedProtocolVersions !== undefined &&
        resolvedSupportedProtocolVersions.includes(resolvedProtocolVersion)
          ? [
              resolvedProtocolVersion,
              ...resolvedSupportedProtocolVersions.filter(
                (version) => version !== resolvedProtocolVersion
              ),
            ]
          : resolvedSupportedProtocolVersions;
      // Automatic era negotiation is always on and transport-agnostic: an
      // unconfigured connection resolves to `{ mode: "auto" }` on both HTTP
      // and stdio (on stdio the `server/discover` probe runs on a sibling
      // process). Explicit pins are honored identically — a modern pin
      // negotiates modern with no legacy fallback, a legacy pin is byte-stable.
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
      // `wrapLegacyClient` also registers this instance for the
      // `io.modelcontextprotocol/tasks` era-gate shadow, which the extension
      // methods this manager exposes (`getTaskExt` / `updateTask` /
      // `cancelTaskExt`) need to reach a 2026-07-28 server. Registration is
      // inert: the shadow is installed on the first such call, never at
      // connect. See `tasks-ext-era-gate.ts`.
      // The trace-context decorator is layered only when an embedder supplied
      // a provider; without one the chain is exactly what it was, so no
      // `traceparent`/`tracestate`/`baggage` key can reach the wire.
      const managedClient: ManagedMcpClient = wrapLegacyClient(
        upstreamClient,
        () => this.perRequestLogLevels.get(serverId),
        this.traceContextProvider
          ? () => this.traceContextProvider?.(serverId)
          : undefined,
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
      // Post-negotiation re-resolution: now that the era is known, a
      // modern-classified connection applies the config's
      // `eraCapabilities.modern` overlay. The stored snapshot is the set
      // actually in force, so the MRTR mode allowlist
      // (`negotiatedElicitationCapability`) and `getServerConnectionInfo`
      // report what the wire really carries.
      state.initializedClientCapabilities = this.applyModernEraCapabilities(
        serverId,
        config,
        upstreamClient,
        clientCapabilities
      );
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
    const transport = this.applyDroppedListChanged(
      config,
      this.applyFirstPageOnly(
        config,
        wrapTransportForTaskResults(
          logger
            ? wrapTransportForLogging(serverId, logger, underlying)
            : underlying
        )
      )
    );

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
        // SEP-2663 HTTP binding: `tasks/get|update|cancel` must carry
        // `Mcp-Name: <taskId>`. beta.4 derives `mcp-name` from
        // `params.name|uri` only, so the header is injected in the fetch seam
        // (hosted inherits it, since hosted builds transports through here).
        // The same seam captures HTTP headers for the wire log when a
        // `httpLogger` is configured — see `buildTransportFetch`.
        fetch: this.buildTransportFetch(serverId, config),
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

      // The upstream Client closes a failed transport during `connect`, and
      // that close fires `onclose` → `clearClosedPendingConnectionState`,
      // discarding the pending live state the SSE fallback below still
      // needs — the fallback then completed only to be thrown away as
      // "cancelled". A FIRST-attempt failure is a fallback trigger, not a
      // client close, so the handler is detached for this attempt and
      // restored on every exit (mid-handshake closes on the attempt that
      // ends up owning the connection keep their cancel semantics).
      const pendingOnClose = client.onclose;
      client.onclose = undefined;
      try {
        const logger = this.resolveRpcLogger(config);
        const wrapped = this.applyDroppedListChanged(
          config,
          this.applyFirstPageOnly(
            config,
            wrapTransportForTaskResults(
              logger
                ? wrapTransportForLogging(serverId, logger, streamableTransport)
                : streamableTransport
            )
          )
        );
        await client.connect(wrapped, {
          timeout: Math.min(timeout, HTTP_CONNECT_TIMEOUT),
        });
        client.onclose = pendingOnClose;
        return streamableTransport;
      } catch (error) {
        streamableError = error;
        await this.safeCloseTransport(streamableTransport);
        client.onclose = pendingOnClose;
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
        // Declared-transport servers (`disableSseFallback`) never downgrade
        // to SSE: surface the Streamable HTTP failure, keeping the auth
        // classification the combined path below would have produced so
        // hosts still see an MCPAuthError where OAuth escalation hooks in.
        if (config.disableSseFallback) {
          const authCheck = isAuthError(error);
          if (authCheck.isAuth) {
            throw new MCPAuthError(
              `Authentication failed for MCP server "${serverId}": Streamable HTTP error: ${formatError(
                error
              )}`,
              authCheck.statusCode,
              { cause: error }
            );
          }
          // Same setting-not-network case as the combined path below. A
          // declared-transport server never reaches that path, so without
          // this the version would go unnamed for exactly the servers most
          // likely to be modern-only.
          const declaredPinFailure = this.protocolPinFailure(serverId, config, [
            error,
          ]);
          if (declaredPinFailure) throw declaredPinFailure;
          // Preserve `cause`: `formatError` reduces the failure to its
          // message, and the Node errno (`ECONNREFUSED`, `ENOTFOUND`, ...)
          // lives on the error object — usually one `.cause` hop down, since
          // undici wraps connect failures as `TypeError("fetch failed")`.
          // Without the chain, `extractNodeErrno` finds nothing and
          // `describeError` degrades from a specific transport slug to
          // message-regex guessing.
          throw new Error(
            `Failed to connect to MCP server "${serverId}" using Streamable HTTP, and this server's declared transport rules out the SSE fallback. Streamable HTTP error: ${formatError(
              error
            )}`,
            { cause: error }
          );
        }
      }
    }

    // A modern pin ends the attempt here — it does NOT downgrade to SSE.
    //
    // Pin mode means "negotiate exactly this revision, no fallback", and the
    // upstream client honors that inside its own negotiation. This manager
    // then layered a SECOND fallback underneath it, which quietly defeated the
    // first: SSE is the legacy transport and carries no pinned version, so a
    // connection that reached it was never speaking the pinned revision. Two
    // outcomes, both wrong. A server whose SSE endpoint works came up on a
    // 2025-era handshake while the UI said the pin was in force. A server that
    // opens an SSE stream and never completes the handshake — a common shape
    // for a modern-only server, which answers `GET /mcp` 200 `text/event-stream`
    // and then has nothing to say on it — left the connect hanging until a
    // caller's timeout fired, reporting "the server may not exist or is not
    // responding" for a server that was answering perfectly well.
    //
    // Failing here turns both into the honest, immediate answer: this server
    // does not offer the version this connection pins.
    const pinFailureBeforeSse = this.protocolPinFailure(serverId, config, [
      streamableError,
    ]);
    if (pinFailureBeforeSse) throw pinFailureBeforeSse;

    const sseTransport = new SSEClientTransport(url, {
      requestInit,
      // `listenGuard: false` — see `buildTransportFetch`. On this transport a
      // GET SSE is the connection, not the listen channel, so `listens:false`
      // is a documented no-op here rather than a connection failure (a real
      // client on HTTP+SSE cannot not-listen either).
      fetch: this.buildTransportFetch(serverId, config, { listenGuard: false }),
      eventSourceInit: config.eventSourceInit,
      authProvider: effectiveAuthProvider,
    });

    try {
      const logger = this.resolveRpcLogger(config);
      const wrapped = this.applyDroppedListChanged(
        config,
        this.applyFirstPageOnly(
          config,
          wrapTransportForTaskResults(
            logger
              ? wrapTransportForLogging(serverId, logger, sseTransport)
              : sseTransport
          )
        )
      );
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
        // `cause` stays the SSE failure for continuity, but the Streamable
        // attempt matters twice as much here: when IT is the auth failure and
        // SSE failed for some other reason, the challenge that triggered this
        // branch lives only on `streamableError`.
        throw attachStreamableCause(
          new MCPAuthError(
            `Authentication failed for MCP server "${serverId}": ${combinedErrorMessage}`,
            statusCode,
            { cause: error }
          ),
          streamableError
        );
      }

      // A pinned protocol version the server does not offer. Checked BEFORE
      // the combined message below, which is where this failure used to
      // disappear: the Streamable attempt fails negotiation naming the
      // version, the SSE attempt then fails on its own terms (a modern-only
      // server answers `405`), and folding the two together produced "failed
      // to connect using HTTP transports … Non-200 status code (405)" — the
      // second attempt's symptom, with no mention of the version or the
      // setting that controls it. `cause` still carries the whole chain.
      const pinFailure = this.protocolPinFailure(serverId, config, [
        streamableError,
        error,
      ]);
      if (pinFailure) {
        throw attachStreamableCause(pinFailure, streamableError);
      }

      // `cause` is the SSE failure (the last attempt, and the one whose errno
      // the message above quotes). Both transports fail with the same errno
      // whenever the server is simply unreachable — ECONNREFUSED, ENOTFOUND —
      // so this is the chain `extractNodeErrno` needs to reach a specific
      // `transport/*` slug instead of message-regex guessing.
      throw attachStreamableCause(
        new Error(
          `Failed to connect to MCP server "${serverId}" using HTTP transports.${streamableMessage} SSE error: ${sseErrorMessage}.`,
          { cause: error }
        ),
        streamableError
      );
    }
  }

  /**
   * Recognize the one connect failure whose cause is a SETTING rather than a
   * network condition: this connection pinned a modern protocol version and
   * the server does not offer it.
   *
   * Returns `undefined` unless the connection was actually in pin mode, so an
   * `auto` connection — which probes and falls back — can never produce this.
   * The mode is derived through `resolveVersionNegotiation`, the same helper
   * the negotiation telemetry uses, rather than re-deriving "is this modern"
   * from the version string: one definition of pin mode, not two.
   *
   * The pin comes from the resolved config, never from parsing the upstream
   * message. The manager is the thing that chose the version; reading it back
   * out of prose would make an upstream rewording silently produce a message
   * with a blank version in it.
   */
  private protocolPinFailure(
    serverId: string,
    config: MCPServerConfig,
    errors: readonly unknown[]
  ): ProtocolVersionPinUnsupported | undefined {
    if (this.isStdioConfig(config)) return undefined;
    const pin = config.mcpProtocolVersion;
    if (!pin) return undefined;
    const negotiation = resolveVersionNegotiation(pin);
    // `"auto"` falls back on its own, so it can never refuse — and a config
    // with no pin already returned above.
    //
    // A legacy pin (`undefined` here: exact `initialize`, no discover probe)
    // DOES refuse, and used to be excluded. It narrows the accept-list to the
    // pinned version, so a server whose `initialize` reply names anything else
    // — e.g. a 2025-11-25 pin against a server that answers 2025-06-18 — fails
    // the connect just as a modern pin does. Excluding it sent that failure to
    // the generic connection patterns, which report the user's own version
    // setting as "the server appears to be down". The verdict below is what
    // keeps a real outage out: it only matches a version refusal.
    if (negotiation?.mode === "auto") return undefined;
    for (const error of errors) {
      // NOT "is this an era-negotiation error": that code also covers a probe
      // that hit an HTTP status, a network failure, or a closed transport —
      // outages, which must keep their transport slug and keep paging rather
      // than being relabelled as the user's version setting.
      const verdict = readUnsupportedVersionFailure(error);
      if (!verdict) continue;
      // `cause` is the negotiation error itself, not the transport failure
      // that happened to be last: it is the one that names what
      // `server/discover` answered, and it is what a support thread needs
      // quoted.
      return new ProtocolVersionPinUnsupported(serverId, pin, {
        cause: error,
        supportedVersions: verdict.supported,
      });
    }
    return undefined;
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
    // Implicit reconnect boundary: a registered-but-disconnected server (after
    // an earlier disconnect or a failed connect) reaches a fresh connection
    // attempt here WITHOUT flowing through `connectToServer`'s try/catch. Emit
    // the negotiation outcome so every real attempt reports exactly once. The
    // in-flight `retryPromise`/`connectPromise` guards above make this mutually
    // exclusive with `connectToServer`'s emission, so no attempt double-emits.
    const config = this.getServerConfig(serverId);
    try {
      await this.connectToServerOnce(serverId, signal);
      if (config) {
        this.emitNegotiationOutcome(serverId, config, "connected", undefined);
      }
    } catch (error) {
      if (config) {
        this.emitNegotiationOutcome(serverId, config, "failed", error);
      }
      throw error;
    }
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
      this.toolsAnnotationsCache.delete(serverId);
      this.aggregatedToolsListWarmed.delete(serverId);
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
    this.toolsAnnotationsCache.delete(serverId);
    this.aggregatedToolsListWarmed.delete(serverId);
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
    this.toolsAnnotationsCache.delete(serverId);
    this.aggregatedToolsListWarmed.delete(serverId);
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

  /**
   * Resolves the client capabilities to advertise to `serverId`.
   *
   * `era` is the connection's classified era when it is actually KNOWN —
   * `undefined` at connect time (pre-negotiation), `"modern"` once the
   * connection has landed on a 2026-era revision. With `era: "modern"` the
   * config's `eraCapabilities.modern` overlay is merged over the base set;
   * see {@link BaseServerConfig.eraCapabilities} for the seam's contract and
   * {@link applyModernEraCapabilities} for when the re-resolution runs.
   */
  private buildCapabilities(
    serverId: string,
    config: MCPServerConfig,
    era?: "modern"
  ): ClientCapabilityOptions {
    // Advertise `elicitation` when EITHER a legacy elicitation handler OR a
    // modern MRTR input collector is registered — a 2026-07-28 server checks
    // the request's declared client capabilities before it will embed an
    // `elicitation/create` in an `input_required` result, so a collector that
    // is registered before connect must be reflected here. roots/sampling are
    // never advertised (this client never fulfils them; MRTR rejects embedded
    // roots/sampling at the result — advertise = enforce).
    //
    // `supportsMrtr: false` (the host config's `mcpProfile.mrtrSupport:
    // "none"`) simulates a client that does not drive MRTR rounds at all, so
    // the MRTR collector stops counting as a fulfiller. On MODERN that
    // removes the only one there is — the inbound `elicitation/create` bridge
    // does not exist on 2026-07-28 — so a legacy handler must not prop the
    // advertisement up either; hosted chat registers a GLOBAL elicitation
    // callback, which would otherwise keep `hasHandler` true and make the
    // knob a silent no-op. On LEGACY the knob is irrelevant: elicitation
    // there is server-initiated, not MRTR, and the SSE bridge still fulfils
    // it. `era` is undefined at connect time, so the legacy fulfiller is
    // still counted then and `applyModernEraCapabilities` narrows once the
    // connection actually classifies as modern.
    const mrtrDisabled = config.supportsMrtr === false;
    const mrtrFulfils = !mrtrDisabled && this.mrtrInputCollectors.has(serverId);
    const legacyFulfils =
      this.elicitationManager.hasHandler(serverId) &&
      !(mrtrDisabled && era === "modern");
    const hasElicitationHandler = legacyFulfils || mrtrFulfils;
    if (config.clientCapabilities) {
      // An EXACT set is advertised verbatim (minus the elicitation gate) on
      // every era — the `eraCapabilities` overlay is deliberately ignored,
      // since widening a pinned declaration would defeat the pin.
      const exactCapabilities = normalizeClientCapabilities(
        config.clientCapabilities
      ) as Record<string, unknown>;

      if (!hasElicitationHandler) {
        delete exactCapabilities.elicitation;
      }

      return exactCapabilities as ClientCapabilityOptions;
    }

    let configuredCapabilities = mergeClientCapabilities(
      this.defaultCapabilities,
      config.capabilities
    );

    if (era === "modern" && config.eraCapabilities?.modern) {
      // The overlay's `elicitation` key gets the strict advertise=enforce
      // gate (dropped without a registered fulfiller) rather than the
      // merge-style leniency `config.capabilities` historically has — it is
      // a new field, so there is no wire behavior to preserve.
      const overlay = {
        ...config.eraCapabilities.modern,
      } as Record<string, unknown>;
      if (!hasElicitationHandler) {
        delete overlay.elicitation;
      }
      configuredCapabilities = mergeClientCapabilities(
        configuredCapabilities,
        overlay as ClientCapabilityOptions
      );
    }

    const resolved = applyRuntimeClientCapabilities(configuredCapabilities, {
      elicitation: hasElicitationHandler,
    });
    // `applyRuntimeClientCapabilities` only ADDS the runtime gate — it cannot
    // remove an `elicitation` that came from `config.capabilities`. That is
    // fine everywhere else (the gate is additive by design), but a modern
    // connection simulating a non-MRTR client must not advertise a capability
    // nothing can fulfil, so delete it explicitly. Scoped to the knob: no
    // other connection's advertised set changes.
    if (mrtrDisabled && era === "modern") {
      delete (resolved as Record<string, unknown>).elicitation;
    }
    return resolved;
  }

  /**
   * The post-negotiation capability re-resolution seam: applies the config's
   * `eraCapabilities.modern` overlay once the connection has classified as
   * 2026-era, and returns the set actually in force for this connection.
   *
   * Runs exactly once per connection, between transport establishment and the
   * live-state publication in {@link performConnection} — so no caller-visible
   * request ever races the widening, and the declaration is stable for the
   * connection's lifetime (MRTR rounds of one logical operation always see one
   * consistent set). Connections that land on a 2025 era — where capabilities
   * were already fixed by the `initialize` handshake — return the connect-time
   * set unchanged, as does any config without an overlay (byte-identical wire
   * behavior to before this seam existed).
   *
   * ## Why this writes the upstream client's private `_capabilities`
   *
   * The upstream `Client` stamps the per-request `_meta` envelope from
   * `this._capabilities` LIVE at request time (`_outboundMetaEnvelope`), so
   * updating the field is sufficient for every subsequent frame. The public
   * `registerCapabilities()` refuses to run once a transport is attached —
   * a guard written for the legacy era, where the declaration really was
   * frozen by `initialize`, that upstream has not yet relaxed for the modern
   * era, where the wire re-declares per request and negotiation (which is
   * what makes the era knowable) cannot complete until after the transport
   * attaches. Until upstream exposes a post-negotiation capability update,
   * this assignment is the seam — same pattern as the tasks era-gate shadow
   * (`tasks-ext-era-gate.ts`). The inbound elicitation mode checks
   * (`getSupportedElicitationModes`) also read `_capabilities` live, so
   * client-side enforcement and the wire stay in lockstep.
   */
  private applyModernEraCapabilities(
    serverId: string,
    config: MCPServerConfig,
    upstreamClient: Client,
    connectCapabilities: ClientCapabilityOptions
  ): ClientCapabilityOptions {
    // `supportsMrtr: false` needs this pass even without an overlay, and even
    // for a pinned exact set: the connect-time build ran with `era`
    // undefined, so it still counted a legacy fulfiller (see
    // `buildCapabilities`). Without re-resolving, a modern connection built
    // without an `eraCapabilities.modern` overlay — every hosted, CLI and raw
    // SDK caller — would keep advertising elicitation and the knob would
    // silently no-op. Re-running is safe for an exact set: `buildCapabilities`
    // applies the same gate to it and otherwise advertises it verbatim.
    const narrowsForMrtr = config.supportsMrtr === false;
    if (
      !narrowsForMrtr &&
      (!config.eraCapabilities?.modern || config.clientCapabilities)
    ) {
      return connectCapabilities;
    }
    const negotiatedVersion = upstreamClient.getNegotiatedProtocolVersion?.();
    if (
      negotiatedVersion === undefined ||
      !isStatelessProtocolVersion(negotiatedVersion)
    ) {
      return connectCapabilities;
    }
    const widened = this.buildCapabilities(serverId, config, "modern");
    (
      upstreamClient as unknown as { _capabilities: ClientCapabilityOptions }
    )._capabilities = widened;
    return widened;
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

  /**
   * Unlike `resolveRpcLogger` there is no console fallback: `logJsonRpc` is
   * about JSON-RPC bodies, and quietly printing every HTTP header set to the
   * console because a caller asked for body logging would leak more than they
   * asked for. Opt in explicitly, per server or globally.
   */
  private resolveHttpLogger(
    config: MCPServerConfig
  ): HttpExchangeLogger | undefined {
    return config.httpLogger ?? this.defaultHttpLogger;
  }

  /**
   * Builds the transport `fetch`. Ordering is load-bearing: the HTTP-log
   * wrapper is the BASE, so it records the headers that actually leave —
   * including the SEP-2663 routing headers `wrapFetchForTaskRouting` injects
   * on top. Without a logger this is byte-identical to the previous
   * `wrapFetchForTaskRouting()`.
   */
  private buildTransportFetch(
    serverId: string,
    config: MCPServerConfig,
    /**
     * Streamable HTTP only. The listen guard identifies the notification
     * stream as "a GET with `Accept: text/event-stream`" — under Streamable
     * HTTP that IS the standalone listen stream, but under the legacy
     * `SSEClientTransport` the very same request is how the transport OPENS
     * the connection (`_startOrAuth` in @modelcontextprotocol/client sends it
     * through this injected fetch with that header). Guarding it there would
     * 405 the connection itself and make every SSE-only server unreachable
     * for any profile carrying `listens: false` — including the shipped
     * ChatGPT template. Header inspection cannot separate the two cases, so
     * the CALLER declares which transport is asking.
     */
    options?: { listenGuard?: boolean }
  ): typeof fetch {
    const httpLogger = this.resolveHttpLogger(config);
    // `baseFetch` is the INNERMOST layer, under the logger: the guard has to
    // see the request that actually leaves, including the routing headers
    // added above it, and the logger has to record the bytes that guard sent.
    // Absent ⇒ both wrappers fall back to `globalThis.fetch` exactly as before.
    const baseFetch = config.baseFetch ?? this.defaultBaseFetch;
    const logged = httpLogger
      ? wrapFetchForHttpLogging(serverId, httpLogger, baseFetch)
      : baseFetch;
    // ABOVE the logger deliberately: a refused listen stream never reaches the
    // network, so logging it would invent a request that was not made. The
    // absence in the log IS the observation.
    const listenGuarded =
      config.suppressListenChannel === true && options?.listenGuard !== false
        ? wrapFetchForNoListenChannel(logged)
        : logged;
    return wrapFetchForTaskRouting(listenGuarded);
  }

  private cacheToolsMetadata(
    serverId: string,
    tools: Array<{
      name: string;
      _meta?: any;
      annotations?: Record<string, unknown>;
    }>
  ): void {
    const metadataMap = new Map<string, any>();
    const annotationsMap = new Map<
      string,
      Record<string, unknown> | undefined
    >();
    for (const tool of tools) {
      if (tool._meta) {
        metadataMap.set(tool.name, tool._meta);
      }
      annotationsMap.set(tool.name, tool.annotations);
    }
    this.toolsMetadataCache.set(serverId, metadataMap);
    this.toolsAnnotationsCache.set(serverId, annotationsMap);
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
      ("request" in value || "retry" in value || "allowTaskResult" in value)
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
  // upstream `callTool` would have asserted), and SEP-2243 `Mcp-Param-*`
  // headers are mirrored per leg.
  //
  // That last one used to be the gap: upstream's mirroring lives inside
  // `callTool`'s private internals, and every MRTR leg goes through
  // `requestWithSchema` (only it can carry `requestState` / `inputResponses`).
  // Because the MRTR collector is registered for EVERY connected server — it
  // is what makes us advertise `elicitation` at all — that gap applied to
  // every modern `tools/call`, not just the ones that actually elicit, and a
  // conforming server answered `-32020 HeaderMismatch`. The legs now scan the
  // tool's `x-mcp-header` declarations themselves (`mcp-header-mirror.ts`) and
  // pass the built headers through `TransportSendOptions.headers`.
  //
  // The MRTR loop lives OUTSIDE the per-leg retry/timeout wrappers, so a
  // transient failure on round N retries only that leg — it never restarts
  // the operation at round zero.
  // ===========================================================================

  private async executeToolWithInputRequired(
    serverId: string,
    callParams: { name: string; arguments?: Record<string, unknown> },
    request: ExecuteToolRequest,
    collect: MrtrInputCollector
  ): Promise<CallToolResult> {
    const baseOptions = request.request;
    const retryPolicy = request.retry ?? { retries: 0, retryDelayMs: 0 };
    // The extension declaration depends on the negotiated wire, so the
    // connection must exist before the (immutable) MRTR params are built.
    await this.ensureConnected(serverId, baseOptions?.signal);
    const mrtrParams = this.withTaskEligibilityDeclaration(
      serverId,
      request,
      callParams as unknown as Record<string, unknown>
    ) as typeof callParams;
    // Resolved once for the whole operation: the tool identity is fixed across
    // legs, so re-scanning per round would repeat the lookup to reach the same
    // answer. The header VALUES are still built per leg, below.
    const declarations = await this.resolveXMcpHeaderDeclarations(
      serverId,
      this.getClientOrThrow(serverId),
      callParams.name,
      {
        ...(baseOptions?.signal ? { signal: baseOptions.signal } : {}),
        ...(baseOptions?.timeout !== undefined
          ? { timeout: baseOptions.timeout }
          : {}),
      }
    );
    const sender: MrtrLegSender<CallToolResult> = (req) =>
      this.runRetriedOperation(
        serverId,
        baseOptions,
        retryPolicy,
        async (signal) => {
          await this.ensureConnected(serverId, signal);
          const client = this.getClientOrThrow(serverId);
          const mergedOptions = this.withProgressHandler(serverId, baseOptions);
          // Built from THIS leg's arguments, not the operation's: the server
          // cross-checks each request's headers against that request's body.
          const paramHeaders =
            declarations.length === 0
              ? undefined
              : buildMcpParamHeaders(
                  declarations,
                  (req.params as { arguments?: unknown } | undefined)?.arguments
                );
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
                {
                  ...callOptions,
                  allowInputRequired: true,
                  // Caller-supplied headers win: an explicit override is a
                  // deliberate act, and the debugger must be able to send a
                  // deliberately wrong header to exercise a server's -32020.
                  ...(paramHeaders && Object.keys(paramHeaders).length > 0
                    ? {
                        headers: {
                          ...paramHeaders,
                          ...(
                            callOptions as { headers?: Record<string, string> }
                          ).headers,
                        },
                      }
                    : {}),
                }
              ) as Promise<CallToolResult | InputRequiredResult>
          );
        }
      );

    return runInputRequiredOperation<CallToolResult>({
      method: "tools/call",
      params: mrtrParams,
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
   * Public reconstruction seam for the HOSTED MRTR resume path (§12.5, PR5).
   *
   * The hosted continuation transport drives an MRTR retry leg via
   * `resumeInputRequiredOperation` (the explicit-schema `requestWithSchema`
   * sender), which — like the local MRTR tool path — bypasses upstream
   * `callTool`'s output-schema assertion. On resume there is no
   * `runInputRequiredOperation` loop to carry the `validateResponse` hook, so a
   * fresh-request resume worker calls this to re-impose the SAME assertion the
   * local path applies, reusing the SAME `DialectAwareJsonSchemaValidator`
   * instance rather than a divergent inspector-side re-implementation. Throws a
   * `TypeError` on a schema mismatch / missing structured content, exactly as
   * the local path does; a best-effort no-op when the schema can't be resolved.
   */
  async assertMrtrToolOutputSchema(
    serverId: string,
    toolName: string,
    result: CallToolResult
  ): Promise<void> {
    return this.validateToolOutputSchema(serverId, toolName, result);
  }

  /**
   * The `Mcp-Param-*` headers one MRTR `tools/call` leg must carry — the public
   * sibling of what {@link executeToolWithInputRequired} does internally, for
   * the surfaces that drive a leg themselves.
   *
   * The HOSTED resume path is why this exists. A resume leg must go through
   * `requestWithSchema` (only it can carry `requestState` / `inputResponses`),
   * which bypasses upstream `callTool` and therefore its private mirroring — so
   * a hosted retry went out unmirrored and a conforming 2026-07-28 server
   * answered `-32020`, while the local path (fixed in #3620) did not. Exposing
   * the seam rather than re-deriving it in `server/utils` is the same choice
   * {@link assertMrtrToolOutputSchema} made for output-schema validation: one
   * implementation, so the two surfaces cannot disagree about what a conforming
   * request looks like.
   *
   * Honors `mirrorToolParamHeaders: false` (host config
   * `toolParamHeaderMirroring: "omit"`) — the simulation has to apply to hosted
   * sessions too, or a user testing a non-conforming client would silently get
   * a conforming one.
   *
   * Built from the LEG's arguments, not the operation's: a server cross-checks
   * each request's headers against that request's body. Best-effort — an
   * unresolvable schema yields `{}` and the leg proceeds exactly as it does
   * today.
   */
  async mrtrToolParamHeaders(
    serverId: string,
    toolName: string,
    args: unknown,
    options?: Pick<ClientRequestOptions, "signal" | "timeout">
  ): Promise<Record<string, string>> {
    await this.ensureConnected(serverId, options?.signal);
    const declarations = await this.resolveXMcpHeaderDeclarations(
      serverId,
      this.getClientOrThrow(serverId),
      toolName,
      options ?? {}
    );
    return declarations.length === 0
      ? {}
      : buildMcpParamHeaders(declarations, args);
  }

  /**
   * Resolves the SEP-2243 `x-mcp-header` declarations for one tool, so an MRTR
   * leg can mirror them into `Mcp-Param-*` the way upstream `callTool` does.
   *
   * Gated exactly like {@link ensureXMcpHeaderMirroringSource} — modern era,
   * non-stdio transport — and warms the same source, so the `listTools` below
   * is served from the response cache without a round trip. Declarations are
   * resolved ONCE per operation; the header VALUES are built per leg, because
   * only the leg's own `arguments` may be mirrored.
   *
   * Best-effort, like the output-schema sibling: an unresolvable schema yields
   * no declarations and the call proceeds unmirrored, which is exactly today's
   * behavior. An INVALID scan also yields none — the same "proceed without
   * custom headers" path upstream takes, leaving the server's `-32020` as the
   * authority rather than inventing a client-side failure.
   */
  private async resolveXMcpHeaderDeclarations(
    serverId: string,
    client: ManagedMcpClient,
    toolName: string,
    options: Pick<ClientRequestOptions, "signal" | "timeout">
  ): Promise<XMcpHeaderDeclaration[]> {
    if (this.xMcpMirroringDisabled(serverId)) return [];
    if (client.getProtocolEra?.() !== "modern") return [];
    const config = this.registeredServers.get(serverId)?.config;
    if (!config || this.isStdioConfig(config)) return [];
    try {
      await this.ensureXMcpHeaderMirroringSource(serverId, client, options);
      // `options` on the lookup too, not just the warm-up: when the warm-up
      // failed (it swallows and is re-attempted per call) this IS the round
      // trip, and one that ignored the caller's abort/deadline could outlive
      // the very call it is serving.
      const list = await client.listTools(undefined, options);
      const tool = list.tools.find(
        (candidate) => candidate.name === toolName
      ) as { inputSchema?: unknown } | undefined;
      if (tool?.inputSchema === undefined) return [];
      const scan = scanXMcpHeaderDeclarations(tool.inputSchema);
      return scan.valid ? scan.declarations : [];
    } catch (error) {
      // Best-effort applies to LOOKUP failures, not to cancellation: swallowing
      // an abort would report "this tool declares nothing" for a call the
      // caller already gave up on, and let the operation continue past it.
      if (isAbortError(error)) throw error;
      return [];
    }
  }

  /**
   * The MRTR input collector to drive rounds with, or `undefined` when this
   * connection simulates a client that does not drive MRTR at all
   * (`MCPServerConfig.supportsMrtr: false`, from the host config's
   * `mcpProfile.mrtrSupport: "none"`).
   *
   * Returning `undefined` is the whole enforcement: every verb gate then
   * takes its plain path, which does NOT pass `allowInputRequired`, so the
   * upstream client rejects an `input_required` result natively with
   * `UNSUPPORTED_RESULT_TYPE` — the same error a client that never
   * implemented MRTR would produce. Nothing about the round-driving code
   * needs a special case, and no `allowInputRequired: true` goes out on the
   * wire claiming a capability the simulated client disclaims.
   *
   * The collector is left REGISTERED so callers that own it (hosted bridge,
   * CLI) need no teardown, and so flipping the knob back does not require
   * re-registration.
   */
  private resolveMrtrCollector(
    serverId: string
  ): ReturnType<Map<string, MrtrInputCollector>["get"]> {
    if (this.registeredServers.get(serverId)?.config.supportsMrtr === false) {
      return undefined;
    }
    return this.mrtrInputCollectors.get(serverId);
  }

  /**
   * Applies `suppressRequestCancellation` to one caller-supplied abort signal.
   *
   * The signal is the ONLY thing that reaches the wire: the protocol layer
   * hangs both cancellation mechanisms off it — aborting the per-request
   * response stream on `2026-07-28` Streamable HTTP, POSTing
   * `notifications/cancelled` on every other era and on stdio. So a host that
   * cancels nothing is modeled by withholding the signal from the request and
   * racing the caller against it locally instead.
   *
   * That split is the whole point. Dropping the signal outright would leave a
   * cancelled turn hanging until the tool finished; passing it through would
   * cancel on the wire. `awaitWithAbort` gives the caller its prompt rejection
   * while the server hears nothing — which is exactly what these hosts do.
   *
   * Deliberately NOT implemented by hiding the transport's
   * `hasPerRequestStream`: that would make a modern connection fall back to
   * POSTing `notifications/cancelled`, a message no conforming client sends on
   * `2026-07-28`. The simulated host must be silent, not wrong.
   */
  private applyCancellationPolicy(
    serverId: string,
    abortSignal: AbortSignal | undefined
  ): {
    requestOptions: { signal: AbortSignal } | undefined;
    settle: <T>(promise: Promise<T>) => Promise<T>;
  } {
    const suppressed =
      this.registeredServers.get(serverId)?.config
        .suppressRequestCancellation === true;

    if (abortSignal === undefined) {
      return { requestOptions: undefined, settle: (promise) => promise };
    }
    if (!suppressed) {
      return {
        requestOptions: { signal: abortSignal },
        settle: (promise) => promise,
      };
    }
    return {
      requestOptions: undefined,
      settle: (promise) => this.awaitWithAbort(promise, abortSignal),
    };
  }

  /**
   * Applies the first-page-only transport wrapper when this connection is
   * configured to simulate a client that stops after page one
   * (`MCPServerConfig.firstPageOnly`, set from the host config's
   * `mcpProfile.paginationTraversal: "firstPageOnly"`).
   *
   * OUTERMOST by design: the logging transport underneath still records the
   * frame the server really sent, so the evidence stays truthful and only the
   * client sees the truncated list. Applied identically on stdio, Streamable
   * HTTP and SSE — pagination is not transport-specific.
   *
   * Read at connect time rather than per call, because the transport is built
   * once per connection; changing the knob takes effect on reconnect, which is
   * how every other connect option behaves.
   */
  private applyFirstPageOnly(
    config: { firstPageOnly?: boolean },
    transport: Transport
  ): Transport {
    return config.firstPageOnly === true
      ? wrapTransportForFirstPageOnly(transport)
      : transport;
  }

  /**
   * Drop `notifications/tools/list_changed` before the client sees it, for a
   * host whose `mcpProfile.toolListChanged.refetches` is `false`.
   *
   * Composed alongside `applyFirstPageOnly` at every transport site: both are
   * inbound-frame edits, and both belong outside the logging transport so the
   * wire log keeps what the server really sent.
   */
  private applyDroppedListChanged(
    config: { dropToolListChanged?: boolean },
    transport: Transport
  ): Transport {
    return config.dropToolListChanged === true
      ? wrapTransportForDroppedListChanged(transport)
      : transport;
  }

  /**
   * Whether this connection was configured to simulate a client that does NOT
   * mirror `x-mcp-header` arguments into `Mcp-Param-*`
   * (`MCPServerConfig.mirrorToolParamHeaders: false`, set from the host
   * config's `mcpProfile.toolParamHeaderMirroring: "omit"`).
   *
   * `undefined` — the shape every pre-existing caller has — means mirror, so
   * nothing changes for anyone who never sets the knob.
   */
  private xMcpMirroringDisabled(serverId: string): boolean {
    return (
      this.registeredServers.get(serverId)?.config.mirrorToolParamHeaders ===
      false
    );
  }

  /**
   * Build the `CallToolRequestOptions.toolDefinition` that SUPPRESSES SEP-2243
   * mirroring on the plain (non-MRTR) `tools/call` path: the tool's own
   * definition with every `x-mcp-header` annotation stripped from its
   * `inputSchema`.
   *
   * Two upstream behaviors make this the seam rather than a flag. `callTool`
   * reads a supplied `toolDefinition`'s `inputSchema` "instead of (and without
   * consulting) the cached `tools/list` result", so a stripped copy is the only
   * way to silence mirroring on a connection whose cache is already warm. And
   * upstream's `-32020 HEADER_MISMATCH` evict-refetch-retry recovery is
   * DISABLED whenever `toolDefinition` is set — which is the point here: a
   * simulated non-conforming client must surface the server's rejection, not
   * quietly recover from it on a second attempt.
   *
   * `outputSchema` is copied through untouched, because upstream validates the
   * result against the SAME definition; stripping it would silently weaken
   * output validation as a side effect of a header knob.
   *
   * Gated like {@link resolveXMcpHeaderDeclarations} — modern era, non-stdio —
   * since mirroring cannot happen elsewhere and a `toolDefinition` there would
   * only change unrelated behavior. It DOES warm the aggregated `tools/list`
   * (the mirroring path's own source) when the cache is cold: without the real
   * definition there is nothing to strip, upstream would fall into its silent
   * miss path, and its recovery retry — armed, because no `toolDefinition` was
   * passed — would refetch and then send the very headers we are simulating the
   * absence of. Best-effort, like its sibling: an unresolvable definition
   * yields `undefined` and the call proceeds unchanged.
   */
  private async resolveUnmirroredToolDefinition(
    serverId: string,
    client: ManagedMcpClient,
    toolName: string,
    options: Pick<ClientRequestOptions, "signal" | "timeout">
  ): Promise<UpstreamToolDefinition | undefined> {
    // The era/transport gates return `undefined` because mirroring cannot
    // happen there AT ALL — no suppression is needed, and a `toolDefinition`
    // would only perturb unrelated behavior.
    if (client.getProtocolEra?.() !== "modern") return undefined;
    const config = this.registeredServers.get(serverId)?.config;
    if (!config || this.isStdioConfig(config)) return undefined;
    try {
      await this.ensureXMcpHeaderMirroringSource(serverId, client, options);
      // `options` on the lookup too, not just the warm-up: when the warm-up
      // failed (it swallows and is re-attempted per call) this IS the round
      // trip, and one that ignored the caller's abort/deadline could outlive
      // the very call it is serving.
      const list = await client.listTools(undefined, options);
      const tool = list.tools.find((candidate) => candidate.name === toolName);
      if (tool) {
        return {
          ...tool,
          inputSchema: stripXMcpHeaderAnnotations(tool.inputSchema),
        } as UpstreamToolDefinition;
      }
    } catch (error) {
      // Same rule as the sibling: cancellation is not a lookup miss.
      if (isAbortError(error)) throw error;
      // Otherwise fall through to the synthetic definition below.
    }
    // The schema could not be resolved — but on THIS path that must not become
    // "give up and mirror". Returning `undefined` here would hand upstream a
    // call with no `toolDefinition`, which mirrors from its own cache AND
    // re-arms the `-32020` evict-refetch-retry recovery, so a transient
    // `tools/list` failure would silently turn the user's non-conforming-client
    // simulation back into a conforming one and hide the server's rejection
    // behind a retry. A minimal definition keeps both guarantees.
    //
    // It costs the call's output-schema validation, which is the honest trade:
    // in exactly these cases upstream could not have resolved an `outputSchema`
    // either (it reads the same aggregated listing), so the alternative is not
    // "validated" but "unvalidated AND silently re-conforming".
    return {
      name: toolName,
      inputSchema: { type: "object" },
    } as UpstreamToolDefinition;
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
