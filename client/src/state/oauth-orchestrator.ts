import {
  clearOAuthData,
  getStoredTokens,
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
  if (!server.oauthTokens) {
    // No tokens, nothing to do; use existing config
    return { kind: "ready", serverConfig: server.config, tokens: undefined };
  }

  // Try refresh first
  const refreshed = await refreshOAuthTokens(server.name);
  if (refreshed.success && refreshed.serverConfig) {
    return {
      kind: "ready",
      serverConfig: refreshed.serverConfig,
      tokens: getStoredTokens(server.name),
    };
  }

  // Fallback to a fresh OAuth flow if URL is present
  // This may redirect away; the hook should reflect oauth-flow state
  const url = (server.config as any)?.url?.toString?.();
  if (url) {
    clearOAuthData(server.name);
    const opts: MCPOAuthOptions = {
      serverName: server.name,
      serverUrl: url,
      clientId: server.oauthTokens?.client_id,
      clientSecret: server.oauthTokens?.client_secret,
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
