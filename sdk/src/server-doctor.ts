import { probeMcpServer } from "./server-probe.js";
import { withEphemeralClient } from "./operations.js";
import { isMethodUnavailableError } from "./mcp-client-manager/index.js";
import type {
  MCPClientManager,
  MCPServerConfig,
  RpcLogger,
} from "./mcp-client-manager/index.js";
import type { ProbeMcpServerResult } from "./server-probe.js";

export interface ServerDoctorError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ServerDoctorCheck {
  status: "ok" | "error" | "skipped";
  detail: string;
}

export interface ServerDoctorConnection {
  status: "connected" | "error" | "skipped";
  detail: string;
}

export interface ServerDoctorChecks {
  probe: ServerDoctorCheck;
  connection: ServerDoctorCheck;
  initialization: ServerDoctorCheck;
  capabilities: ServerDoctorCheck;
  tools: ServerDoctorCheck;
  resources: ServerDoctorCheck;
  resourceTemplates: ServerDoctorCheck;
  prompts: ServerDoctorCheck;
}

export interface ServerDoctorResult<TTarget = unknown> {
  target: TTarget;
  generatedAt: string;
  status: "ready" | "oauth_required" | "partial" | "error";
  probe: ProbeMcpServerResult | null;
  connection: ServerDoctorConnection;
  initInfo: unknown | null;
  capabilities: unknown | null;
  tools: unknown[];
  toolsMetadata: Record<string, unknown>;
  resources: unknown[];
  resourceTemplates: unknown[];
  prompts: unknown[];
  checks: ServerDoctorChecks;
  error: ServerDoctorError | null;
}

export interface ConnectedServerDoctorState {
  initInfo: unknown | null;
  capabilities: unknown | null;
  tools: unknown[];
  toolsMetadata: Record<string, unknown>;
  resources: unknown[];
  resourceTemplates: unknown[];
  prompts: unknown[];
  checks: Pick<
    ServerDoctorChecks,
    | "initialization"
    | "capabilities"
    | "tools"
    | "resources"
    | "resourceTemplates"
    | "prompts"
  >;
  errors: ServerDoctorError[];
}

export interface RunServerDoctorInput<TTarget = unknown> {
  config: MCPServerConfig;
  target: TTarget;
  timeout: number;
  rpcLogger?: RpcLogger;
}

type WithConnectedManager = <T>(
  config: MCPServerConfig,
  fn: (manager: MCPClientManager, serverId: string) => Promise<T>,
  options?: { timeout?: number; rpcLogger?: RpcLogger },
) => Promise<T>;

export interface ServerDoctorDependencies {
  probeServer?: typeof probeMcpServer;
  withManager?: WithConnectedManager;
}

export async function runServerDoctor<TTarget = unknown>(
  input: RunServerDoctorInput<TTarget>,
  dependencies: ServerDoctorDependencies = {},
): Promise<ServerDoctorResult<TTarget>> {
  const probeServer = dependencies.probeServer ?? probeMcpServer;
  const withManager =
    dependencies.withManager ??
    ((config, fn, options) =>
      withEphemeralClient(config, fn, {
        timeout: options?.timeout,
        rpcLogger: options?.rpcLogger,
        serverId: "__cli__",
        clientName: "mcpjam",
      }));
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
      probe: skippedCheck("HTTP probe not applicable for stdio targets."),
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

  if ("url" in input.config) {
    const probeUrl = input.config.url;
    if (!probeUrl) {
      throw new Error("HTTP doctor flow requires a server URL.");
    }

    try {
      result.probe = await probeServer({
        url: probeUrl,
        headers: extractHeaders(input.config.requestInit?.headers),
        ...(resolveProbeAccessToken(input.config)
          ? { accessToken: resolveProbeAccessToken(input.config) }
          : {}),
        ...(resolveDoctorClientCapabilities(input.config)
          ? { clientCapabilities: resolveDoctorClientCapabilities(input.config) }
          : {}),
        timeoutMs: input.timeout,
      });
      result.checks.probe = summarizeProbeCheck(
        result.probe,
        hasConnectionCredentials(input.config),
      );
    } catch (error) {
      const structured = normalizeServerDoctorError(error);
      result.checks.probe = errorCheck(
        `HTTP probe failed: ${structured.message}`,
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
        detail:
          "Server requires OAuth before a connection can be established.",
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
  }

  try {
    const collected = await withManager(
      input.config,
      (manager, serverId) => collectConnectedServerDoctorState(manager, serverId),
      {
        timeout: input.timeout,
        rpcLogger: input.rpcLogger,
      },
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
  }

  result.status = deriveDoctorStatus(result);
  if (result.status === "ready") {
    result.error = null;
  }

  return result;
}

export async function collectConnectedServerDoctorState(
  manager: MCPClientManager,
  serverId: string,
): Promise<ConnectedServerDoctorState> {
  const errors: ServerDoctorError[] = [];
  const initInfo = manager.getInitializationInfo(serverId) ?? null;
  const capabilities = manager.getServerCapabilities(serverId) ?? null;

  const [toolsResult, resourcesResult, promptsResult, resourceTemplatesResult] =
    await Promise.all([
      collectTools(manager, serverId),
      collectResources(manager, serverId),
      collectPrompts(manager, serverId),
      collectResourceTemplates(manager, serverId),
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
        : errorCheck("Server connected but did not return initialization info."),
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

export function normalizeServerDoctorError(error: unknown): ServerDoctorError {
  if (isServerDoctorError(error)) {
    return error;
  }

  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";
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

function isServerDoctorError(error: unknown): error is ServerDoctorError {
  return (
    !!error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

async function collectTools(
  manager: MCPClientManager,
  serverId: string,
): Promise<{
  tools: unknown[];
  toolsMetadata: Record<string, unknown>;
  check: ServerDoctorCheck;
  error?: ServerDoctorError;
}> {
  try {
    const result = await manager.listTools(serverId);
    const tools = result.tools ?? [];
    return {
      tools,
      toolsMetadata: manager.getAllToolsMetadata(serverId),
      check: okCheck(describeCount(tools.length, "tool")),
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
  manager: MCPClientManager,
  serverId: string,
): Promise<{
  resources: unknown[];
  check: ServerDoctorCheck;
  error?: ServerDoctorError;
}> {
  try {
    const result = await manager.listResources(serverId);
    const resources = result.resources ?? [];
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
  manager: MCPClientManager,
  serverId: string,
): Promise<{
  prompts: unknown[];
  check: ServerDoctorCheck;
  error?: ServerDoctorError;
}> {
  try {
    const result = await manager.listPrompts(serverId);
    const prompts = result.prompts ?? [];
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
  manager: MCPClientManager,
  serverId: string,
): Promise<{
  resourceTemplates: unknown[];
  check: ServerDoctorCheck;
  error?: ServerDoctorError;
}> {
  try {
    const result = await manager.listResourceTemplates(serverId);
    const resourceTemplates = result.resourceTemplates ?? [];
    return {
      resourceTemplates,
      check: okCheck(
        describeCount(resourceTemplates.length, "resource template"),
      ),
    };
  } catch (error) {
    if (
      isMethodUnavailableError(error, "resources/templates") ||
      isUnsupportedMethodError(error, "resources/templates")
    ) {
      return {
        resourceTemplates: [],
        check: skippedCheck("Server does not support resources/templates."),
      };
    }

    const structured = normalizeServerDoctorError(error);
    return {
      resourceTemplates: [],
      check: errorCheck(structured.message),
      error: structured,
    };
  }
}

function resolveProbeAccessToken(config: MCPServerConfig): string | undefined {
  if (!("url" in config)) {
    return undefined;
  }

  const explicitToken = config.accessToken?.trim();
  if (explicitToken) {
    return explicitToken;
  }

  const headers = extractHeaders(config.requestInit?.headers);
  const authorizationHeader = headers.Authorization ?? headers.authorization;
  if (!authorizationHeader) {
    return undefined;
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function resolveDoctorClientCapabilities(
  config: MCPServerConfig,
): Record<string, unknown> | undefined {
  return config.clientCapabilities ?? config.capabilities;
}

function extractHeaders(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    const normalized: Record<string, string> = {};
    headers.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(
      headers.map(([key, value]) => [key, String(value)]),
    );
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  );
}

function summarizeProbeCheck(
  probe: ProbeMcpServerResult,
  hasCredentials: boolean,
): ServerDoctorCheck {
  switch (probe.status) {
    case "ready":
      return okCheck(
        `HTTP initialize probe succeeded via ${
          probe.transport.selected ?? "unknown transport"
        }.`,
      );
    case "oauth_required":
      return hasCredentials
        ? okCheck(
            "Unauthenticated probe requires OAuth; continuing with provided credentials.",
          )
        : errorCheck("Server requires OAuth before it can be connected.");
    case "reachable":
      return errorCheck(
        "HTTP endpoint was reachable, but the initialize probe did not complete successfully.",
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
  result: ServerDoctorResult<TTarget>,
): ServerDoctorResult<TTarget>["status"] {
  if (result.probe?.status === "oauth_required" && result.connection.status === "skipped") {
    return "oauth_required";
  }

  if (result.connection.status === "error") {
    return "error";
  }

  return Object.values(result.checks).some((check) => check.status === "error")
    ? "partial"
    : "ready";
}

function hasConnectionCredentials(config: MCPServerConfig): boolean {
  return "url" in config && Boolean(resolveProbeAccessToken(config) || config.refreshToken);
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

function isUnsupportedMethodError(
  error: unknown,
  method: string,
): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const lower = message.toLowerCase();
  const normalizedMethod = method.toLowerCase();

  return (
    lower.includes(normalizedMethod) &&
    (lower.includes("not found") ||
      lower.includes("not implemented") ||
      lower.includes("unsupported") ||
      lower.includes("unavailable") ||
      lower.includes("does not support"))
  );
}
