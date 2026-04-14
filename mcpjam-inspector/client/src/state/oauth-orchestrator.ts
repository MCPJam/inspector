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

export type OAuthReady = {
  kind: "ready";
  serverConfig: any;
  tokens?: any;
};
export type OAuthRedirect = { kind: "redirect" };
export type OAuthError = { kind: "error"; error: string };
export type OAuthResult = OAuthReady | OAuthRedirect | OAuthError;

export async function ensureAuthorizedForReconnect(
  server: ServerWithName,
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
  if (server.oauthTokens) {
    // Try refresh first
    const refreshed = await refreshOAuthTokens(server.name);
    if (refreshed.success && refreshed.serverConfig) {
      return {
        kind: "ready",
        serverConfig: refreshed.serverConfig,
        tokens: getStoredTokens(server.name),
      };
    }
  }

  // Fallback to a fresh OAuth flow if URL is present
  // This may redirect away; the hook should reflect oauth-flow state
  const storedServerUrl = localStorage.getItem(`mcp-serverUrl-${server.name}`);
  const storedClientInfo = localStorage.getItem(`mcp-client-${server.name}`);
  const storedTokens = getStoredTokens(server.name);

  const url = (server.config as any)?.url?.toString?.() || storedServerUrl;
  if (url) {
    // Get stored OAuth configuration
    const oauthConfig = readStoredOAuthConfig(server.name);
    const clientInfo = storedClientInfo ? JSON.parse(storedClientInfo) : {};
    const oauthProfile = server.oauthFlowProfile;

    const opts: MCPOAuthOptions = {
      serverName: server.name,
      serverUrl: url,
      clientId:
        oauthProfile?.clientId ||
        server.oauthTokens?.client_id ||
        storedTokens?.client_id ||
        clientInfo?.client_id,
      clientSecret:
        oauthProfile?.clientSecret ||
        server.oauthTokens?.client_secret || clientInfo?.client_secret,
      scopes:
        (oauthProfile?.scopes?.trim()
          ? oauthProfile.scopes
              .split(/\s+/)
              .filter((scope) => scope.length > 0)
          : undefined) ?? oauthConfig.scopes,
      protocolVersion:
        oauthProfile?.protocolVersion ?? oauthConfig.protocolVersion,
      registrationStrategy:
        oauthProfile?.registrationStrategy ?? oauthConfig.registrationStrategy,
      registryServerId: oauthConfig.registryServerId,
      useRegistryOAuthProxy: oauthConfig.useRegistryOAuthProxy,
    } as MCPOAuthOptions;
    const init = await initiateOAuth(opts);
    if (init.success && init.serverConfig) {
      return {
        kind: "ready",
        serverConfig: init.serverConfig,
        tokens: getStoredTokens(server.name),
      };
    }
    if (init.success && !init.serverConfig) {
      return { kind: "redirect" };
    }
    return { kind: "error", error: init.error || "OAuth init failed" };
  }

  return { kind: "error", error: "OAuth refresh failed and no URL present" };
}
