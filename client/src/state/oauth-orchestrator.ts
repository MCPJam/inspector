import {
  clearOAuthData,
  getStoredTokens,
  hasOAuthConfig,
  initiateOAuth,
  refreshOAuthTokens,
  MCPOAuthOptions,
} from "@/lib/mcp-oauth";
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
  // Check if OAuth was configured by looking at multiple sources
  if (!server.oauthTokens && !hasOAuthConfig(server.name)) {
    // No OAuth was ever configured, use existing config
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
  const storedOAuthConfig = localStorage.getItem(`mcp-oauth-config-${server.name}`);
  const storedTokens = getStoredTokens(server.name);

  const url = (server.config as any)?.url?.toString?.() || storedServerUrl;
  if (url) {
    // Get stored OAuth configuration
    const oauthConfig = storedOAuthConfig ? JSON.parse(storedOAuthConfig) : {};
    const clientInfo = storedClientInfo ? JSON.parse(storedClientInfo) : {};

    const opts: MCPOAuthOptions = {
      serverName: server.name,
      serverUrl: url,
      clientId: server.oauthTokens?.client_id || storedTokens?.client_id || clientInfo?.client_id,
      clientSecret: server.oauthTokens?.client_secret || clientInfo?.client_secret,
      scopes: oauthConfig.scopes,
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
