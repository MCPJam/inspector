import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type RequestOptions,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  getDefaultClientCapabilities,
  mergeClientCapabilities,
  normalizeClientCapabilities,
} from "./mcp-client-manager/capabilities.js";
import {
  DEFAULT_CLIENT_VERSION,
  HTTP_CONNECT_TIMEOUT,
} from "./mcp-client-manager/constants.js";
import { isMethodUnavailableError } from "./mcp-client-manager/error-utils.js";
import {
  buildRequestInit,
  createDefaultRpcLogger,
  wrapTransportForLogging,
} from "./mcp-client-manager/transport-utils.js";
import { probeMcpServer } from "./server-probe.js";
import { CspSafeDialectAwareJsonSchemaValidator } from "./mcp-client-manager/csp-safe-dialect-aware-json-schema-validator.js";
import type {
  HttpServerConfig,
  MCPPrompt,
  MCPResourceTemplate,
  RpcLogger,
} from "./mcp-client-manager/types.js";
import {
  isRetryableTransientError,
  retryWithPolicy,
  type RetryPolicy,
} from "./retry.js";
import {
  applyConnectedServerDoctorState,
  buildConnectedServerDoctorState,
  buildDoctorProbeConfig,
  createServerDoctorResult,
  deriveDoctorStatus,
  describeCount,
  errorCheck,
  hasConnectionCredentials,
  normalizeServerDoctorError,
  okCheck,
  skippedCheck,
  summarizeProbeCheck,
} from "./server-doctor-core.js";
import type {
  ConnectedServerDoctorState,
  DoctorPromptsCollectionResult,
  DoctorResourceTemplatesCollectionResult,
  DoctorResourcesCollectionResult,
  DoctorToolsCollectionResult,
  ServerDoctorResult,
} from "./server-doctor-core.js";

const MAX_PAGINATION_PAGES = 1000;

type ClientWithDoctorState = Client & {
  getInitializationInfo?: () => unknown;
  getServerCapabilities?: () => unknown;
};

interface BrowserDoctorClient {
  close: Client["close"];
  getInitializationInfo: () => unknown;
  getServerCapabilities: () => unknown;
  listPrompts: Client["listPrompts"];
  listResourceTemplates: Client["listResourceTemplates"];
  listResources: Client["listResources"];
  listTools: Client["listTools"];
}

export type ConnectedHttpServerDoctorState = ConnectedServerDoctorState;

export interface RunHttpServerDoctorInput<TTarget = unknown> {
  config: HttpServerConfig;
  target: TTarget;
  timeout: number;
  rpcLogger?: RpcLogger;
  retryPolicy?: RetryPolicy;
}

export interface HttpServerDoctorDependencies {
  probeServer?: typeof probeMcpServer;
  connectClient?: (
    config: HttpServerConfig,
    options: {
      timeout: number;
      rpcLogger?: RpcLogger;
      retryPolicy?: RetryPolicy;
    }
  ) => Promise<BrowserDoctorClient>;
}

export async function runHttpServerDoctor<TTarget = unknown>(
  input: RunHttpServerDoctorInput<TTarget>,
  dependencies: HttpServerDoctorDependencies = {}
): Promise<ServerDoctorResult<TTarget>> {
  const probeServer = dependencies.probeServer ?? probeMcpServer;
  const connectClient = dependencies.connectClient ?? connectHttpDoctorClient;
  const result = createServerDoctorResult(input.target);

  try {
    result.probe = await probeServer(
      buildDoctorProbeConfig(input.config, {
        timeout: input.timeout,
        retryPolicy: input.retryPolicy,
      })
    );
    result.checks.probe = summarizeProbeCheck(
      result.probe,
      hasConnectionCredentials(input.config)
    );
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    result.checks.probe = errorCheck(
      `HTTP probe failed: ${structured.message}`
    );
    result.error = structured;
  }

  if (
    result.probe?.status === "oauth_required" &&
    !hasConnectionCredentials(input.config)
  ) {
    result.status = "oauth_required";
    result.connection = {
      status: "skipped",
      detail: "Server requires OAuth before a connection can be established.",
    };
    result.checks.connection = skippedCheck(result.connection.detail);
    result.error = {
      code: "OAUTH_REQUIRED",
      message:
        "Server requires OAuth before it can be connected. Run an OAuth login flow first.",
      details: {
        registrationStrategies: result.probe.oauth.registrationStrategies,
        authorizationServerMetadataUrl:
          result.probe.oauth.authorizationServerMetadataUrl,
        resourceMetadataUrl: result.probe.oauth.resourceMetadataUrl,
      },
    };
    return result;
  }

  let client: BrowserDoctorClient | null = null;

  try {
    const connectedClient = await connectClient(input.config, {
      timeout: input.timeout,
      rpcLogger: input.rpcLogger,
      retryPolicy: input.retryPolicy,
    });
    client = connectedClient;

    const collected = await collectConnectedHttpServerDoctorState(
      connectedClient,
      {
        timeout: input.timeout,
        retryPolicy: input.retryPolicy,
      }
    );

    applyConnectedServerDoctorState(result, collected);
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    result.connection = {
      status: "error",
      detail: structured.message,
    };
    result.checks.connection = errorCheck(structured.message);
    result.error = structured;
  } finally {
    if (client !== null) {
      await safeCloseClient(client);
    }
  }

  result.status = deriveDoctorStatus(result);
  if (result.status === "ready") {
    result.error = null;
  }

  return result;
}

export async function collectConnectedHttpServerDoctorState(
  client: BrowserDoctorClient,
  options: {
    timeout: number;
    retryPolicy?: RetryPolicy;
  }
): Promise<ConnectedHttpServerDoctorState> {
  const initInfo = client.getInitializationInfo() ?? null;
  const capabilities = client.getServerCapabilities() ?? null;

  const [toolsResult, resourcesResult, promptsResult, resourceTemplatesResult] =
    await Promise.all([
      collectTools(client, options),
      collectResources(client, options),
      collectPrompts(client, capabilities, options),
      collectResourceTemplates(client, options),
    ]);

  return buildConnectedServerDoctorState({
    initInfo,
    capabilities,
    toolsResult,
    resourcesResult,
    promptsResult,
    resourceTemplatesResult,
    // This doctor drives a bare client rather than an MCPClientManager, and the
    // verified skills read path is manager-shaped. Reporting `skipped` states
    // that honestly instead of implying the server serves none.
    skillsResult: {
      skills: [],
      check: skippedCheck(
        "Skills over MCP is not inspected on this surface."
      ),
    },
  });
}

async function collectTools(
  client: BrowserDoctorClient,
  options: { timeout: number; retryPolicy?: RetryPolicy }
): Promise<DoctorToolsCollectionResult> {
  try {
    const tools = await drainPaginatedList<
      Awaited<ReturnType<BrowserDoctorClient["listTools"]>>["tools"][number],
      Awaited<ReturnType<BrowserDoctorClient["listTools"]>>
    >(
      async (cursor) =>
        withRetry(
          () =>
            client.listTools(
              // Presence, not truthiness: `""` is a valid continuation cursor.
              cursor !== undefined ? { cursor } : undefined,
              withTimeout(options.timeout)
            ),
          options.retryPolicy
        ).catch((error) => {
          if (isMethodUnavailableError(error, "tools/list")) {
            return { tools: [] } as Awaited<
              ReturnType<BrowserDoctorClient["listTools"]>
            >;
          }
          throw error;
        }),
      "tools/list",
      (page) => page.tools ?? []
    );

    const toolsMetadata: Record<string, unknown> = {};
    const toolsWithoutMeta =
      tools?.map((tool) => {
        if (tool._meta !== undefined) {
          toolsMetadata[tool.name] = tool._meta;
        }
        const { _meta: _ignoredMeta, ...toolWithoutMeta } = tool;
        return toolWithoutMeta;
      }) ?? [];

    return {
      tools: toolsWithoutMeta,
      toolsMetadata,
      check: okCheck(describeCount(toolsWithoutMeta.length, "tool")),
    };
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    return {
      tools: [],
      toolsMetadata: {},
      check: errorCheck(structured.message),
      error: structured,
    };
  }
}

async function collectResources(
  client: BrowserDoctorClient,
  options: { timeout: number; retryPolicy?: RetryPolicy }
): Promise<DoctorResourcesCollectionResult> {
  try {
    const resources = await drainPaginatedList<
      Awaited<
        ReturnType<BrowserDoctorClient["listResources"]>
      >["resources"][number],
      Awaited<ReturnType<BrowserDoctorClient["listResources"]>>
    >(
      async (cursor) =>
        withRetry(
          () =>
            client.listResources(
              // Presence, not truthiness: `""` is a valid continuation cursor.
              cursor !== undefined ? { cursor } : undefined,
              withTimeout(options.timeout)
            ),
          options.retryPolicy
        ).catch((error) => {
          if (isMethodUnavailableError(error, "resources/list")) {
            return { resources: [] } as Awaited<
              ReturnType<BrowserDoctorClient["listResources"]>
            >;
          }
          throw error;
        }),
      "resources/list",
      (page) => page.resources ?? []
    );

    return {
      resources,
      check: okCheck(describeCount(resources.length, "resource")),
    };
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    return {
      resources: [],
      check: errorCheck(structured.message),
      error: structured,
    };
  }
}

async function collectPrompts(
  client: BrowserDoctorClient,
  capabilities: unknown,
  options: { timeout: number; retryPolicy?: RetryPolicy }
): Promise<DoctorPromptsCollectionResult> {
  try {
    const promptCapabilities =
      capabilities &&
      typeof capabilities === "object" &&
      "prompts" in capabilities
        ? (capabilities as { prompts?: unknown }).prompts
        : undefined;
    if (promptCapabilities === undefined && capabilities) {
      return {
        prompts: [],
        check: okCheck(describeCount(0, "prompt")),
      };
    }

    const prompts = await drainPaginatedList<
      MCPPrompt,
      Awaited<ReturnType<BrowserDoctorClient["listPrompts"]>>
    >(
      async (cursor) =>
        withRetry(
          () =>
            client.listPrompts(
              // Presence, not truthiness: `""` is a valid continuation cursor.
              cursor !== undefined ? { cursor } : undefined,
              withTimeout(options.timeout)
            ),
          options.retryPolicy
        ).catch((error) => {
          if (isMethodUnavailableError(error, "prompts/list")) {
            return { prompts: [] } as Awaited<
              ReturnType<BrowserDoctorClient["listPrompts"]>
            >;
          }
          throw error;
        }),
      "prompts/list",
      (page) => page.prompts ?? []
    );

    return {
      prompts,
      check: okCheck(describeCount(prompts.length, "prompt")),
    };
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    return {
      prompts: [],
      check: errorCheck(structured.message),
      error: structured,
    };
  }
}

async function collectResourceTemplates(
  client: BrowserDoctorClient,
  options: { timeout: number; retryPolicy?: RetryPolicy }
): Promise<DoctorResourceTemplatesCollectionResult> {
  try {
    let unsupported = false;
    const resourceTemplates = await drainPaginatedList<
      MCPResourceTemplate,
      Awaited<ReturnType<BrowserDoctorClient["listResourceTemplates"]>>
    >(
      async (cursor) =>
        withRetry(
          () =>
            client.listResourceTemplates(
              // Presence, not truthiness: `""` is a valid continuation cursor.
              cursor !== undefined ? { cursor } : undefined,
              withTimeout(options.timeout)
            ),
          options.retryPolicy
        ).catch((error) => {
          if (
            isMethodUnavailableError(error, "resources/templates") ||
            (error instanceof Error ? error.message : String(error))
              .toLowerCase()
              .includes("resources/templates")
          ) {
            unsupported = true;
            return { resourceTemplates: [] } as Awaited<
              ReturnType<BrowserDoctorClient["listResourceTemplates"]>
            >;
          }
          throw error;
        }),
      "resources/templates",
      (page) => page.resourceTemplates ?? []
    );

    return unsupported
      ? {
          resourceTemplates,
          check: skippedCheck("Server does not support resources/templates."),
        }
      : {
          resourceTemplates,
          check: okCheck(
            describeCount(resourceTemplates.length, "resource template")
          ),
        };
  } catch (error) {
    const structured = normalizeServerDoctorError(error);
    return {
      resourceTemplates: [],
      check: errorCheck(structured.message),
      error: structured,
    };
  }
}

async function connectHttpDoctorClient(
  config: HttpServerConfig,
  options: {
    timeout: number;
    rpcLogger?: RpcLogger;
    retryPolicy?: RetryPolicy;
  }
): Promise<BrowserDoctorClient> {
  if (config.refreshToken) {
    throw new Error(
      "Browser-safe HTTP doctor does not support refreshToken-based authentication."
    );
  }

  // No `io.modelcontextprotocol/tasks` era-gate shadow here: it is installed
  // from the extension's own send path, and the doctor issues no `tasks/*`
  // request at all (its `BrowserDoctorClient` surface is capabilities + the
  // three list calls), so there is nothing for the gate to block.
  const client = new Client(
    {
      name: "mcpjam",
      version: config.version ?? DEFAULT_CLIENT_VERSION,
    },
    {
      capabilities: config.clientCapabilities
        ? normalizeClientCapabilities(config.clientCapabilities)
        : mergeClientCapabilities(
            getDefaultClientCapabilities(),
            config.capabilities
          ),
      // Validate declared draft-07 schemas instead of rejecting them (the
      // upstream default is 2020-12-only and fails tools/call for v1-SDK
      // servers with an outputSchema). CSP-safe flavor: this path ships in
      // the browser and workerd entries, where Ajv's `new Function` is
      // unavailable.
      jsonSchemaValidator: new CspSafeDialectAwareJsonSchemaValidator(),
    }
  );

  if (config.onError) {
    client.onerror = (error: Error) => config.onError?.(error);
  }

  try {
    const transport = await connectViaHttp(config, client, options);
    if (transport) {
      const statefulClient = client as ClientWithDoctorState;
      return {
        close: client.close.bind(client),
        getInitializationInfo: () =>
          (statefulClient.getInitializationInfo?.() ?? null) as unknown,
        getServerCapabilities: () =>
          (statefulClient.getServerCapabilities?.() ?? null) as unknown,
        listPrompts: client.listPrompts.bind(client),
        listResourceTemplates: client.listResourceTemplates.bind(client),
        listResources: client.listResources.bind(client),
        listTools: client.listTools.bind(client),
      };
    }
    throw new Error("Failed to connect to HTTP MCP server.");
  } catch (error) {
    await safeCloseClient(client);
    throw error;
  }
}

async function connectViaHttp(
  config: HttpServerConfig,
  client: Client,
  options: {
    timeout: number;
    rpcLogger?: RpcLogger;
  }
): Promise<Transport> {
  const url = new URL(config.url);
  const requestInit = buildRequestInit(
    config.accessToken?.trim() || undefined,
    config.requestInit
  );
  const preferSSE = config.preferSSE ?? url.pathname.endsWith("/sse");
  const logger = resolveRpcLogger(config, options.rpcLogger);
  let streamableError: unknown;

  if (!preferSSE) {
    const streamableTransport = new StreamableHTTPClientTransport(url, {
      requestInit,
      reconnectionOptions: config.reconnectionOptions,
      authProvider: config.authProvider,
      sessionId: config.sessionId,
    });

    try {
      const wrapped = logger
        ? wrapTransportForLogging("http-doctor", logger, streamableTransport)
        : streamableTransport;
      await client.connect(wrapped, {
        timeout: Math.min(options.timeout, HTTP_CONNECT_TIMEOUT),
      });
      return streamableTransport;
    } catch (error) {
      streamableError = error;
      await safeCloseTransport(streamableTransport);
      // Same opt-out the connect path honors: a server whose transport was
      // DECLARED streamable-http must not be diagnosed "ready" over SSE.
      // Without this the doctor contradicts MCPClientManager, which refuses
      // the very same server — misleading diagnostics on an SSE-only
      // endpoint that the declaration says should not be used.
      if (config.disableSseFallback) {
        throw error;
      }
    }
  }

  const sseTransport = new SSEClientTransport(url, {
    requestInit,
    eventSourceInit: config.eventSourceInit,
    authProvider: config.authProvider,
  });

  try {
    const wrapped = logger
      ? wrapTransportForLogging("http-doctor", logger, sseTransport)
      : sseTransport;
    await client.connect(wrapped, { timeout: options.timeout });
    return sseTransport;
  } catch (error) {
    await safeCloseTransport(sseTransport);

    if (streamableError) {
      const streamableMessage =
        streamableError instanceof Error
          ? streamableError.message
          : String(streamableError);
      const sseMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Streamable HTTP error: ${streamableMessage}. SSE error: ${sseMessage}`
      );
    }

    throw error;
  }
}

function resolveRpcLogger(
  config: HttpServerConfig,
  rpcLogger: RpcLogger | undefined
): RpcLogger | undefined {
  if (rpcLogger) {
    return rpcLogger;
  }
  if (config.rpcLogger) {
    return config.rpcLogger;
  }
  if (config.logJsonRpc) {
    return createDefaultRpcLogger();
  }
  return undefined;
}

async function safeCloseClient(
  client: Pick<BrowserDoctorClient, "close">
): Promise<void> {
  try {
    await client.close();
  } catch {
    // Ignore cleanup errors.
  }
}

async function safeCloseTransport(transport: Transport): Promise<void> {
  try {
    await transport.close();
  } catch {
    // Ignore cleanup errors.
  }
}

async function drainPaginatedList<TItem, TPage extends { nextCursor?: string }>(
  fetchPage: (cursor?: string) => Promise<TPage>,
  methodName: string,
  selectItems: (page: TPage) => readonly TItem[]
): Promise<TItem[]> {
  const items: TItem[] = [];
  // Cycle guard. Without it, a server that reissues a cursor it already handed
  // out re-requests the identical page until the cap — up to
  // `MAX_PAGINATION_PAGES` round trips, each carrying this module's timeout and
  // retry handling. `""` joins the set like any other token, so a server
  // answering `""` forever trips this on the SECOND occurrence.
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;

  while (pages < MAX_PAGINATION_PAGES) {
    const page = await fetchPage(cursor);
    items.push(...selectItems(page));
    pages += 1;

    // ABSENCE ends the walk, not emptiness. MCP 2026-07-28
    // `server/utilities/pagination` states that a client "MUST NOT" decide
    // anything from a cursor's value beyond whether a non-null one was
    // provided, and that "an empty string is a valid cursor and thus MUST NOT
    // be treated as the end of results". A NON-STRING `nextCursor` is not a
    // cursor at all and still ends the walk.
    if (typeof page.nextCursor !== "string") {
      return items;
    }

    if (seenCursors.has(page.nextCursor)) {
      throw new Error(
        `Detected repeated cursor ${JSON.stringify(
          page.nextCursor
        )} while draining ${methodName}.`
      );
    }

    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  throw new Error(
    `${methodName} exceeded ${MAX_PAGINATION_PAGES} pages while collecting doctor state.`
  );
}

function withTimeout(timeout: number): RequestOptions {
  return { timeout };
}

function withRetry<T>(
  operation: () => Promise<T>,
  retryPolicy: RetryPolicy | undefined
): Promise<T> {
  return retryWithPolicy({
    policy: retryPolicy,
    operation: () => operation(),
    shouldRetryError: (error) => isRetryableTransientError(error),
  });
}
