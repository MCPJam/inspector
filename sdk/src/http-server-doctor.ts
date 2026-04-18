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
  getExistingAuthorization,
  normalizeHeaders,
  wrapTransportForLogging,
} from "./mcp-client-manager/transport-utils.js";
import { probeMcpServer } from "./server-probe.js";
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
import type { ProbeMcpServerResult } from "./server-probe.js";
import type {
  ServerDoctorCheck,
  ServerDoctorError,
  ServerDoctorResult,
} from "./server-doctor.js";

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

export interface ConnectedHttpServerDoctorState {
  initInfo: unknown | null;
  capabilities: unknown | null;
  tools: unknown[];
  toolsMetadata: Record<string, unknown>;
  resources: unknown[];
  resourceTemplates: unknown[];
  prompts: unknown[];
  checks: Pick<
    ServerDoctorResult["checks"],
    | "initialization"
    | "capabilities"
    | "prompts"
    | "resourceTemplates"
    | "resources"
    | "tools"
  >;
  errors: ServerDoctorError[];
}

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
  const generatedAt = new Date().toISOString();

  const result: ServerDoctorResult<TTarget> = {
    target: input.target,
    generatedAt,
    status: "ready",
    probe: null,
    connection: {
      status: "skipped",
      detail: "Connection step did not run.",
    },
    initInfo: null,
    capabilities: null,
    tools: [],
    toolsMetadata: {},
    resources: [],
    resourceTemplates: [],
    prompts: [],
    checks: {
      probe: skippedCheck("HTTP probe did not run."),
      connection: skippedCheck("Connection step did not run."),
      initialization: skippedCheck("Initialization info was not collected."),
      capabilities: skippedCheck("Capabilities were not collected."),
      tools: skippedCheck("Tools were not collected."),
      resources: skippedCheck("Resources were not collected."),
      resourceTemplates: skippedCheck("Resource templates were not collected."),
      prompts: skippedCheck("Prompts were not collected."),
    },
    error: null,
  };

  try {
    result.probe = await probeServer({
      url: input.config.url,
      headers: normalizeHeaders(input.config.requestInit?.headers),
      ...(resolveProbeAccessToken(input.config)
        ? { accessToken: resolveProbeAccessToken(input.config) }
        : {}),
      ...(resolveDoctorClientCapabilities(input.config)
        ? {
            clientCapabilities: resolveDoctorClientCapabilities(input.config),
          }
        : {}),
      timeoutMs: input.timeout,
      retryPolicy: input.retryPolicy,
    });
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

    result.connection = {
      status: "connected",
      detail: "Connected and initialized successfully.",
    };
    result.checks.connection = okCheck(result.connection.detail);
    result.initInfo = collected.initInfo;
    result.capabilities = collected.capabilities;
    result.tools = collected.tools;
    result.toolsMetadata = collected.toolsMetadata;
    result.resources = collected.resources;
    result.resourceTemplates = collected.resourceTemplates;
    result.prompts = collected.prompts;
    result.checks.initialization = collected.checks.initialization;
    result.checks.capabilities = collected.checks.capabilities;
    result.checks.tools = collected.checks.tools;
    result.checks.resources = collected.checks.resources;
    result.checks.resourceTemplates = collected.checks.resourceTemplates;
    result.checks.prompts = collected.checks.prompts;

    if (collected.errors.length > 0) {
      result.error = collected.errors[0] ?? result.error;
    }
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
  const errors: ServerDoctorError[] = [];
  const initInfo = client.getInitializationInfo() ?? null;
  const capabilities = client.getServerCapabilities() ?? null;

  const [toolsResult, resourcesResult, promptsResult, resourceTemplatesResult] =
    await Promise.all([
      collectTools(client, options),
      collectResources(client, options),
      collectPrompts(client, capabilities, options),
      collectResourceTemplates(client, options),
    ]);

  for (const error of [
    toolsResult.error,
    resourcesResult.error,
    promptsResult.error,
    resourceTemplatesResult.error,
  ]) {
    if (error) {
      errors.push(error);
    }
  }

  return {
    initInfo,
    capabilities,
    tools: toolsResult.tools,
    toolsMetadata: toolsResult.toolsMetadata,
    resources: resourcesResult.resources,
    resourceTemplates: resourceTemplatesResult.resourceTemplates,
    prompts: promptsResult.prompts,
    checks: {
      initialization: initInfo
        ? okCheck("Initialization info captured.")
        : errorCheck(
            "Server connected but did not return initialization info."
          ),
      capabilities: capabilities
        ? okCheck("Server capabilities captured.")
        : errorCheck("Server connected but did not advertise capabilities."),
      tools: toolsResult.check,
      resources: resourcesResult.check,
      resourceTemplates: resourceTemplatesResult.check,
      prompts: promptsResult.check,
    },
    errors,
  };
}

async function collectTools(
  client: BrowserDoctorClient,
  options: { timeout: number; retryPolicy?: RetryPolicy }
): Promise<{
  tools: unknown[];
  toolsMetadata: Record<string, unknown>;
  check: ServerDoctorCheck;
  error?: ServerDoctorError;
}> {
  try {
    const tools = await drainPaginatedList<
      Awaited<ReturnType<BrowserDoctorClient["listTools"]>>["tools"][number],
      Awaited<ReturnType<BrowserDoctorClient["listTools"]>>
    >(
      async (cursor) =>
        withRetry(
          () =>
            client.listTools(
              cursor ? { cursor } : undefined,
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
): Promise<{
  resources: unknown[];
  check: ServerDoctorCheck;
  error?: ServerDoctorError;
}> {
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
              cursor ? { cursor } : undefined,
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
): Promise<{
  prompts: unknown[];
  check: ServerDoctorCheck;
  error?: ServerDoctorError;
}> {
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
              cursor ? { cursor } : undefined,
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
): Promise<{
  resourceTemplates: unknown[];
  check: ServerDoctorCheck;
  error?: ServerDoctorError;
}> {
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
              cursor ? { cursor } : undefined,
              withTimeout(options.timeout)
            ),
          options.retryPolicy
        ).catch((error) => {
          if (
            isMethodUnavailableError(error, "resources/templates") ||
            formatErrorMessage(error)
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
  let cursor: string | undefined;
  let pages = 0;

  while (pages < MAX_PAGINATION_PAGES) {
    const page = await fetchPage(cursor);
    items.push(...selectItems(page));
    pages += 1;

    if (!page.nextCursor) {
      return items;
    }

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

function resolveProbeAccessToken(config: HttpServerConfig): string | undefined {
  const explicitToken = config.accessToken?.trim();
  if (explicitToken) {
    return explicitToken;
  }

  const headers = normalizeHeaders(config.requestInit?.headers);
  const authorizationHeader = getExistingAuthorization(headers);
  if (!authorizationHeader) {
    return undefined;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function resolveDoctorClientCapabilities(
  config: HttpServerConfig
): Record<string, unknown> | undefined {
  return config.clientCapabilities ?? config.capabilities;
}

function hasConnectionCredentials(config: HttpServerConfig): boolean {
  return Boolean(
    resolveProbeAccessToken(config) ||
      config.authProvider ||
      config.refreshToken
  );
}

function summarizeProbeCheck(
  probe: ProbeMcpServerResult,
  hasCredentials: boolean
): ServerDoctorCheck {
  switch (probe.status) {
    case "ready":
      return okCheck(
        `HTTP initialize probe succeeded via ${
          probe.transport.selected ?? "unknown transport"
        }.`
      );
    case "oauth_required":
      return hasCredentials
        ? okCheck(
            "Unauthenticated probe requires OAuth; continuing with provided credentials."
          )
        : errorCheck("Server requires OAuth before it can be connected.");
    case "reachable":
      return errorCheck(
        "HTTP endpoint was reachable, but the initialize probe did not complete successfully."
      );
    case "error":
      return errorCheck(probe.error ?? "HTTP probe failed.");
    default: {
      const exhaustive: never = probe.status;
      return errorCheck(String(exhaustive));
    }
  }
}

function deriveDoctorStatus<TTarget>(
  result: ServerDoctorResult<TTarget>
): ServerDoctorResult<TTarget>["status"] {
  if (
    result.probe?.status === "oauth_required" &&
    result.connection.status === "skipped"
  ) {
    return "oauth_required";
  }

  if (result.connection.status === "error") {
    return "error";
  }

  return Object.values(result.checks).some((check) => check.status === "error")
    ? "partial"
    : "ready";
}

function normalizeServerDoctorError(error: unknown): ServerDoctorError {
  const message = formatErrorMessage(error);
  const lower = message.toLowerCase();

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return { code: "TIMEOUT", message };
  }

  if (
    lower.includes("connect") ||
    lower.includes("connection") ||
    lower.includes("refused") ||
    lower.includes("econn")
  ) {
    return { code: "SERVER_UNREACHABLE", message };
  }

  return { code: "INTERNAL_ERROR", message };
}

function okCheck(detail: string): ServerDoctorCheck {
  return { status: "ok", detail };
}

function errorCheck(detail: string): ServerDoctorCheck {
  return { status: "error", detail };
}

function skippedCheck(detail: string): ServerDoctorCheck {
  return { status: "skipped", detail };
}

function describeCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"} discovered.`;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
