import {
  clearOAuthData,
  getStoredTokens,
  hasOAuthConfig,
  initiateOAuth,
  readStoredOAuthConfig,
  refreshOAuthTokens,
  MCPOAuthOptions,
} from "@/lib/oauth/mcp-oauth";
import { ServerWithName } from "./app-types";
import type { OAuthTrace } from "@/lib/oauth/oauth-trace";

export type OAuthReady = {
  kind: "ready";
  serverConfig: any;
  tokens?: any;
  oauthTrace?: OAuthTrace;
};
export type OAuthRedirect = { kind: "redirect" };
export type OAuthReauthRequired = {
  kind: "reauth_required";
  error: string;
  oauthTrace?: OAuthTrace;
};
export type OAuthError = { kind: "error"; error: string; oauthTrace?: OAuthTrace };
export type OAuthResult =
  | OAuthReady
  | OAuthRedirect
  | OAuthReauthRequired
  | OAuthError;

function buildOAuthReauthRequired(
  serverName: string,
  oauthTrace?: OAuthTrace,
): OAuthReauthRequired {
  return {
    kind: "reauth_required",
    error: `OAuth consent is required for ${serverName}. Click Reconnect to continue.`,
    oauthTrace,
  };
}

export async function ensureAuthorizedForReconnect(
  server: ServerWithName,
  options?: {
    beforeRedirect?: (oauthOptions: MCPOAuthOptions) => void;
    onTraceUpdate?: (trace: OAuthTrace) => void;
    allowInteractiveOAuthFlow?: boolean;
  },
): Promise<OAuthResult> {
  // If server is explicitly configured without OAuth, skip OAuth flow entirely
  // This handles the case where a server was saved with "No Authentication"
  if (server.useOAuth === false) {
    // Also clear any lingering OAuth data in localStorage
    clearOAuthData(server.name);
    return { kind: "ready", serverConfig: server.config, tokens: undefined };
  }

  // If useOAuth is not explicitly true and there are no OAuth tokens,
  // skip OAuth (handles legacy servers and non-OAuth connections)
  if (server.useOAuth !== true && !server.oauthTokens) {
    // Clear any lingering OAuth data that might cause confusion
    clearOAuthData(server.name);
    return { kind: "ready", serverConfig: server.config, tokens: undefined };
  }

  // If OAuth was configured, try to refresh or re-initiate
  let refreshTrace: OAuthTrace | undefined;
  if (server.oauthTokens) {
    // Try refresh first
    const refreshed = await refreshOAuthTokens(server.name, {
      onTraceUpdate: options?.onTraceUpdate,
    });
    if (refreshed.success && refreshed.serverConfig) {
      return {
        kind: "ready",
        serverConfig: refreshed.serverConfig,
        tokens: getStoredTokens(server.name),
        oauthTrace: refreshed.oauthTrace,
      };
    }
    refreshTrace = refreshed.oauthTrace;
  }

  const storedServerUrl = localStorage.getItem(`mcp-serverUrl-${server.name}`);
  const url = (server.config as any)?.url?.toString?.() || storedServerUrl;

  if (options?.allowInteractiveOAuthFlow === false) {
    if (url) {
      return buildOAuthReauthRequired(server.name, refreshTrace);
    }
    return {
      kind: "error",
      error: "OAuth refresh failed and no URL present",
      oauthTrace: refreshTrace,
    };
  }

  // Fallback to a fresh OAuth flow if URL is present
  // This may redirect away; the hook should reflect oauth-flow state
  if (url) {
    const storedClientInfo = localStorage.getItem(`mcp-client-${server.name}`);
    const storedTokens = getStoredTokens(server.name);

    // Get stored OAuth configuration
    const oauthConfig = readStoredOAuthConfig(server.name);
    const clientInfo = storedClientInfo ? JSON.parse(storedClientInfo) : {};
    const effectiveRegistrationStrategy =
      server.oauthFlowProfile?.registrationStrategy ??
      oauthConfig.registrationStrategy;
    const shouldReuseStoredClientCredentials =
      effectiveRegistrationStrategy === "preregistered";

    const opts: MCPOAuthOptions = {
      serverName: server.name,
      serverUrl: url,
      scopes: oauthConfig.scopes,
      customHeaders: oauthConfig.customHeaders,
      registryServerId: oauthConfig.registryServerId,
      useRegistryOAuthProxy: oauthConfig.useRegistryOAuthProxy,
      protocolVersion:
        server.oauthFlowProfile?.protocolVersion ?? oauthConfig.protocolVersion,
      registrationStrategy: effectiveRegistrationStrategy,
    } as MCPOAuthOptions;

    if (shouldReuseStoredClientCredentials) {
      opts.clientId =
        server.oauthTokens?.client_id ||
        storedTokens?.client_id ||
        clientInfo?.client_id;
      opts.clientSecret =
        server.oauthTokens?.client_secret || clientInfo?.client_secret;
    }
    options?.beforeRedirect?.(opts);
    opts.onTraceUpdate = options?.onTraceUpdate;
    const init = await initiateOAuth(opts);
    if (init.success && init.serverConfig) {
      return {
        kind: "ready",
        serverConfig: init.serverConfig,
        tokens: getStoredTokens(server.name),
        oauthTrace: init.oauthTrace,
      };
    }
    if (init.success && !init.serverConfig) {
      return { kind: "redirect" };
    }
    return {
      kind: "error",
      error: init.error || "OAuth init failed",
      oauthTrace: init.oauthTrace,
    };
  }

  return { kind: "error", error: "OAuth refresh failed and no URL present" };
}
