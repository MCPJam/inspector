import { MCPClientManager, isAuthError } from "./mcp-client-manager/index.js";
import type {
  MCPServerConfig,
  RpcLogger,
} from "./mcp-client-manager/index.js";
import type { RetryPolicy } from "./retry.js";
import {
  buildConnectedServerDoctorResult,
  collectConnectedServerDoctorState,
  normalizeServerDoctorError,
  runServerDoctor,
} from "./server-doctor.js";
import type { ServerDoctorResult } from "./server-doctor.js";
import type {
  ConnectContext,
  ConnectIssue,
  ConnectIssueCode,
  ConnectPhase,
  ConnectReport,
} from "./connect-report-types.js";

export interface ConnectServerWithReportInput {
  config: MCPServerConfig;
  target: string;
  serverId?: string;
  manager?: MCPClientManager;
  timeout?: number;
  rpcLogger?: RpcLogger;
  retryPolicy?: RetryPolicy;
  disconnectBeforeConnect?: boolean;
  diagnostics?: "on_failure" | "never";
  context?: Partial<Pick<ConnectContext, "oauth">>;
}

export interface ConnectServerWithReportDependencies {
  runDoctor?: typeof runServerDoctor;
  collectConnectedState?: typeof collectConnectedServerDoctorState;
  buildConnectedDoctorResult?: typeof buildConnectedServerDoctorResult;
}

const DEFAULT_SERVER_ID = "__connect_report__";
const DEFAULT_TIMEOUT_MS = 30_000;

export async function connectServerWithReport(
  input: ConnectServerWithReportInput,
  dependencies: ConnectServerWithReportDependencies = {},
): Promise<ConnectReport> {
  const serverId = input.serverId ?? DEFAULT_SERVER_ID;
  const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS;
  const ownsManager = !input.manager;
  const manager =
    input.manager ??
    new MCPClientManager(
      {},
      {
        defaultTimeout: timeout,
        defaultClientName: "mcpjam-sdk",
        lazyConnect: true,
        ...(input.retryPolicy ? { retryPolicy: input.retryPolicy } : {}),
        ...(input.rpcLogger ? { rpcLogger: input.rpcLogger } : {}),
      },
    );

  const reportContext: ConnectContext = {
    requestedClientCapabilities:
      resolveRequestedClientCapabilities(input.config) ?? null,
    ...(input.context?.oauth ? { oauth: input.context.oauth } : {}),
  };

  try {
    if (input.disconnectBeforeConnect) {
      await manager.disconnectServer(serverId).catch(() => undefined);
    }

    try {
      await manager.connectToServer(serverId, input.config);
    } catch (error) {
      const issue = classifyConnectIssue(error, input.config);
      const diagnostics =
        input.diagnostics === "never"
          ? undefined
          : await collectFailureDiagnostics(
              input,
              dependencies.runDoctor ?? runServerDoctor,
            );

      return {
        success: false,
        status:
          issue.code === "OAUTH_REQUIRED" ? "oauth_required" : "failed",
        target: input.target,
        initInfo: manager.getInitializationInfo(serverId) ?? null,
        issue,
        ...(diagnostics ? { diagnostics } : {}),
        context: reportContext,
      };
    }

    const initInfo = manager.getInitializationInfo(serverId) ?? null;

    try {
      await manager.getToolsForAiSdk([serverId]);
      return {
        success: true,
        status: "connected",
        target: input.target,
        initInfo,
        context: reportContext,
      };
    } catch (error) {
      const issue = classifyValidationIssue(error);
      let diagnostics: ServerDoctorResult | undefined;
      try {
        diagnostics = await collectPartialDiagnostics(
          manager,
          serverId,
          input.target,
          error,
          dependencies.collectConnectedState ??
            collectConnectedServerDoctorState,
          dependencies.buildConnectedDoctorResult ??
            buildConnectedServerDoctorResult,
        );
      } catch {
        diagnostics = undefined;
      }

      return {
        success: true,
        status: "partial",
        target: input.target,
        initInfo,
        issue,
        ...(diagnostics ? { diagnostics } : {}),
        context: reportContext,
      };
    }
  } finally {
    if (ownsManager) {
      await manager.disconnectAllServers().catch(() => undefined);
    }
  }
}

async function collectFailureDiagnostics(
  input: ConnectServerWithReportInput,
  runDoctorFn: typeof runServerDoctor,
): Promise<ServerDoctorResult | undefined> {
  try {
    return await runDoctorFn({
      config: input.config,
      target: input.target,
      timeout: input.timeout ?? DEFAULT_TIMEOUT_MS,
      rpcLogger: input.rpcLogger,
      retryPolicy: input.retryPolicy,
    });
  } catch {
    return undefined;
  }
}

async function collectPartialDiagnostics(
  manager: MCPClientManager,
  serverId: string,
  target: string,
  error: unknown,
  collectConnectedState: typeof collectConnectedServerDoctorState,
  buildConnectedDoctorResultFn: typeof buildConnectedServerDoctorResult,
): Promise<ServerDoctorResult> {
  const collected = await collectConnectedState(manager, serverId);
  const diagnostics = buildConnectedDoctorResultFn(target, collected);
  const normalizedError = normalizeServerDoctorError(error);

  diagnostics.status = "partial";
  diagnostics.error = normalizedError;
  diagnostics.checks.tools = {
    status: "error",
    detail: normalizedError.message,
  };

  return diagnostics;
}

function classifyConnectIssue(
  error: unknown,
  config: MCPServerConfig,
): ConnectIssue {
  const normalized = normalizeServerDoctorError(error);
  const auth = isAuthError(error);
  const hasCredentials = hasConnectionCredentials(config);

  if (auth.isAuth) {
    const code: ConnectIssueCode = hasCredentials
      ? "AUTH_ERROR"
      : "OAUTH_REQUIRED";
    return {
      code,
      phase: "authorize",
      message:
        code === "OAUTH_REQUIRED"
          ? "Server requires OAuth before it can be connected."
          : normalized.message,
      ...(auth.statusCode ? { statusCode: auth.statusCode } : {}),
      retryable: true,
    };
  }

  if (normalized.code === "TIMEOUT") {
    return issue("TIMEOUT", "connect", normalized.message, true);
  }

  if (normalized.code === "SERVER_UNREACHABLE") {
    return issue("SERVER_UNREACHABLE", "connect", normalized.message, true);
  }

  if ("command" in config) {
    return issue("STDIO_START_FAILED", "connect", normalized.message);
  }

  if ("url" in config) {
    return issue(
      "TRANSPORT_NEGOTIATION_FAILED",
      "connect",
      normalized.message,
      true,
    );
  }

  return issue("INTERNAL_ERROR", "connect", normalized.message);
}

function classifyValidationIssue(error: unknown): ConnectIssue {
  const normalized = normalizeServerDoctorError(error);
  return issue(
    "POST_CONNECT_VALIDATION_FAILED",
    "post_connect",
    normalized.message,
    false,
  );
}

function issue(
  code: ConnectIssueCode,
  phase: ConnectPhase,
  message: string,
  retryable?: boolean,
): ConnectIssue {
  return {
    code,
    phase,
    message,
    ...(retryable === undefined ? {} : { retryable }),
  };
}

function hasConnectionCredentials(config: MCPServerConfig): boolean {
  if (!("url" in config)) {
    return false;
  }

  if (typeof config.accessToken === "string" && config.accessToken.trim()) {
    return true;
  }

  if (typeof config.refreshToken === "string" && config.refreshToken.trim()) {
    return true;
  }

  const headers = extractHeaders(config.requestInit?.headers);
  const authorization = headers.Authorization ?? headers.authorization;
  return (
    typeof authorization === "string" &&
    /^Bearer\s+.+$/i.test(authorization.trim())
  );
}

function resolveRequestedClientCapabilities(
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
    const values: Record<string, string> = {};
    headers.forEach((value, key) => {
      values[key] = value;
    });
    return values;
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
