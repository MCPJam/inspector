import type {
  MCPConformanceResult,
  MCPAppsCheckId,
  MCPAppsConformanceResult,
  MCPCheckId,
  MCPLogLevel,
  MCPOAuthReadinessId,
  MCPReadinessId,
  MCPTasksCheckId,
  MCPTasksReadinessId,
  MCPTasksConformanceResult,
  McpProtocolVersion,
  ConformanceResult as OAuthConformanceResult,
} from "@mcpjam/sdk";
import { isHostedMode, runByMode } from "@/lib/apis/mode-client";
import { buildServerRequest } from "@/lib/apis/web/context";
import { webPost } from "@/lib/apis/web/base";
import { localPost } from "@/lib/apis/local-post";

// ── Types ───────────────────────────────────────────────────────────────

export interface OAuthConformanceStartResult {
  phase: "authorization_needed" | "complete";
  sessionId?: string;
  authorizationUrl?: string;
  completedSteps?: Array<{ step: string; status: string }>;
  result?: OAuthConformanceResult;
}

export interface OAuthConformanceCompleteResult {
  phase: "pending" | "complete";
  completedSteps?: Array<{ step: string; status: string }>;
  result?: OAuthConformanceResult;
}

export interface OAuthStartInput {
  serverNameOrId: string;
  oauthProfile?: {
    serverUrl?: string;
    protocolVersion?: string;
    registrationStrategy?: string;
    clientId?: string;
    clientSecret?: string;
    scopes?: string;
    customHeaders?: Array<{ key: string; value: string }>;
  };
  callbackOrigin?: string;
  /** The advice to report; absent reports all of it, empty none. */
  readinessIds?: MCPOAuthReadinessId[];
}

// ── Public API ──────────────────────────────────────────────────────────

/** A tool named as safe for a protocol check to call, with its arguments. */
export interface ConformanceProbe {
  toolName: string;
  arguments?: Record<string, unknown>;
  /**
   * `logProbe` only: the log level the log level filtering advice asks for.
   * Absent means the SDK's default, `warning`.
   */
  level?: MCPLogLevel;
  /**
   * `tasksProbe` only: the answers `tasks/update` sends when the task asks
   * for input, keyed by `inputRequests` key. Absent means the update
   * acknowledgement check is not applicable.
   */
  inputResponses?: Record<string, unknown>;
}

/**
 * The tools the checks that must call one may use: `logProbe` for the logging
 * check and the log level filtering advice, `inputRequiredProbe` for the
 * undeclared-capability check, `toolCallProbe` for the output-schema check,
 * `tasksProbe` for the Tasks checks that need a created task.
 */
export interface ConformanceProbes {
  logProbe?: ConformanceProbe;
  inputRequiredProbe?: ConformanceProbe;
  toolCallProbe?: ConformanceProbe;
  tasksProbe?: ConformanceProbe;
}

export async function runProtocolConformance(
  serverNameOrId: string,
  options?: {
    protocolVersion?: McpProtocolVersion;
    checkIds?: MCPCheckId[];
    /** The advice to run; absent runs all of it, empty runs none. */
    readinessIds?: MCPReadinessId[];
    probes?: ConformanceProbes;
  },
): Promise<{ success: boolean; result: MCPConformanceResult }> {
  const versionFields = {
    ...(options?.protocolVersion
      ? { protocolVersion: options.protocolVersion }
      : {}),
    ...(options?.checkIds ? { checkIds: options.checkIds } : {}),
    ...(options?.readinessIds ? { readinessIds: options.readinessIds } : {}),
    ...(options?.probes?.logProbe ? { logProbe: options.probes.logProbe } : {}),
    ...(options?.probes?.inputRequiredProbe
      ? { inputRequiredProbe: options.probes.inputRequiredProbe }
      : {}),
    ...(options?.probes?.toolCallProbe
      ? { toolCallProbe: options.probes.toolCallProbe }
      : {}),
  };
  return runByMode({
    local: () =>
      localPost("/api/mcp/conformance/protocol", {
        serverId: serverNameOrId,
        ...versionFields,
      }),
    hosted: () => {
      const request = buildServerRequest(serverNameOrId);
      return webPost("/api/web/conformance/protocol", {
        ...request,
        ...versionFields,
      });
    },
  });
}

export async function runAppsConformance(
  serverNameOrId: string,
  options?: {
    checkIds?: MCPAppsCheckId[];
    protocolVersion?: McpProtocolVersion;
  },
): Promise<{ success: boolean; result: MCPAppsConformanceResult }> {
  const checkFields = {
    ...(options?.checkIds ? { checkIds: options.checkIds } : {}),
    ...(options?.protocolVersion
      ? { protocolVersion: options.protocolVersion }
      : {}),
  };
  return runByMode({
    local: () =>
      localPost("/api/mcp/conformance/apps", {
        serverId: serverNameOrId,
        ...checkFields,
      }),
    hosted: () => {
      const request = buildServerRequest(serverNameOrId);
      return webPost("/api/web/conformance/apps", {
        ...request,
        ...checkFields,
      });
    },
  });
}

/**
 * The runner opens its own ephemeral client for the length of the run, so
 * this works on both modes. Hosted clamps the task poll window server-side to
 * fit inside its per-request budget.
 */
export async function runTasksConformance(
  serverNameOrId: string,
  options?: {
    protocolVersion?: McpProtocolVersion;
    toolName?: string;
    toolArguments?: Record<string, unknown>;
    inputResponses?: Record<string, unknown>;
    checkIds?: MCPTasksCheckId[];
    /** The advice to report; absent reports all of it, empty none. */
    readinessIds?: MCPTasksReadinessId[];
  },
): Promise<{ success: boolean; result: MCPTasksConformanceResult }> {
  const optionFields = {
    ...(options?.protocolVersion
      ? { protocolVersion: options.protocolVersion }
      : {}),
    ...(options?.checkIds ? { checkIds: options.checkIds } : {}),
    ...(options?.readinessIds ? { readinessIds: options.readinessIds } : {}),
    ...(options?.toolName ? { toolName: options.toolName } : {}),
    ...(options?.toolArguments ? { toolArguments: options.toolArguments } : {}),
    ...(options?.inputResponses
      ? { inputResponses: options.inputResponses }
      : {}),
  };
  return runByMode({
    local: () =>
      localPost("/api/mcp/conformance/tasks", {
        serverId: serverNameOrId,
        ...optionFields,
      }),
    hosted: () => {
      const request = buildServerRequest(serverNameOrId);
      return webPost("/api/web/conformance/tasks", {
        ...request,
        ...optionFields,
      });
    },
  });
}

export async function startOAuthConformance(
  input: OAuthStartInput,
): Promise<OAuthConformanceStartResult> {
  return runByMode({
    local: () =>
      localPost("/api/mcp/conformance/oauth/start", {
        serverId: input.serverNameOrId,
        oauthProfile: input.oauthProfile,
        callbackOrigin: input.callbackOrigin,
        ...(input.readinessIds ? { readinessIds: input.readinessIds } : {}),
      }),
    hosted: () => {
      const request = buildServerRequest(input.serverNameOrId);
      return webPost("/api/web/conformance/oauth/start", {
        ...request,
        oauthProfile: input.oauthProfile,
        callbackOrigin: input.callbackOrigin,
        ...(input.readinessIds ? { readinessIds: input.readinessIds } : {}),
      });
    },
  });
}

export async function submitOAuthConformanceCode(input: {
  sessionId: string;
  code: string;
  state?: string;
}): Promise<{ success: boolean }> {
  const path = isHostedMode()
    ? "/api/web/conformance/oauth/authorize"
    : "/api/mcp/conformance/oauth/authorize";

  if (isHostedMode()) {
    return webPost(path, input);
  }
  return localPost(path, input);
}

export async function completeOAuthConformance(
  sessionId: string,
): Promise<OAuthConformanceCompleteResult> {
  const path = isHostedMode()
    ? "/api/web/conformance/oauth/complete"
    : "/api/mcp/conformance/oauth/complete";

  if (isHostedMode()) {
    return webPost(path, { sessionId });
  }
  return localPost(path, { sessionId });
}
