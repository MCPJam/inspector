import type {
  MCPConformanceResult,
  MCPAppsConformanceResult,
  ConformanceResult as OAuthConformanceResult,
} from "@mcpjam/sdk";
import { isHostedMode, runByMode } from "@/lib/apis/mode-client";
import { buildHostedServerRequest } from "@/lib/apis/web/context";
import { webPost } from "@/lib/apis/web/base";
import { authFetch } from "@/lib/session-token";

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
  runNegativeChecks?: boolean;
  callbackOrigin?: string;
}

// ── Local API helpers ───────────────────────────────────────────────────

async function localPost<T>(path: string, body: unknown): Promise<T> {
  const response = await authFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data as T;
}

// ── Public API ──────────────────────────────────────────────────────────

export async function runProtocolConformance(
  serverNameOrId: string,
): Promise<{ success: boolean; result: MCPConformanceResult }> {
  return runByMode({
    local: () =>
      localPost("/api/mcp/conformance/protocol", {
        serverId: serverNameOrId,
      }),
    hosted: () => {
      const request = buildHostedServerRequest(serverNameOrId);
      return webPost("/api/web/conformance/protocol", request);
    },
  });
}

export async function runAppsConformance(
  serverNameOrId: string,
): Promise<{ success: boolean; result: MCPAppsConformanceResult }> {
  return runByMode({
    local: () =>
      localPost("/api/mcp/conformance/apps", {
        serverId: serverNameOrId,
      }),
    hosted: () => {
      const request = buildHostedServerRequest(serverNameOrId);
      return webPost("/api/web/conformance/apps", request);
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
        runNegativeChecks: input.runNegativeChecks,
        callbackOrigin: input.callbackOrigin,
      }),
    hosted: () => {
      const request = buildHostedServerRequest(input.serverNameOrId);
      return webPost("/api/web/conformance/oauth/start", {
        ...request,
        oauthProfile: input.oauthProfile,
        runNegativeChecks: input.runNegativeChecks,
        callbackOrigin: input.callbackOrigin,
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
