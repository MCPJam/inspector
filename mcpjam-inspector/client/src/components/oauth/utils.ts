import type { ServerWithName } from "@/hooks/use-app-state";
import type { HttpServerConfig } from "@mcpjam/sdk/browser";
import {
  EMPTY_OAUTH_TEST_PROFILE,
  type OAuthTestProfile,
} from "@/lib/oauth/profile";
import { getStoredTokens } from "@/lib/oauth/mcp-oauth";

// The Connect editor (use-server-form) surfaces a server's clientId/scopes
// from browser storage — a DCR-registered client id, the scopes the last
// OAuth run was granted — even when those were never written to
// oauthFlowProfile. Mirror that read so the OAuth/XAA modals don't show
// those fields blank for a server the Connect page clearly knows about.
const readStoredOAuthCredentials = (
  serverName?: string,
): { clientId: string; scopes: string } => {
  if (!serverName) return { clientId: "", scopes: "" };
  try {
    const storedTokens = getStoredTokens(serverName);
    const clientInfo = JSON.parse(
      localStorage.getItem(`mcp-client-${serverName}`) || "{}",
    );
    const oauthConfig = JSON.parse(
      localStorage.getItem(`mcp-oauth-config-${serverName}`) || "{}",
    );
    const clientId =
      (typeof storedTokens?.client_id === "string" && storedTokens.client_id) ||
      (typeof clientInfo?.client_id === "string" && clientInfo.client_id) ||
      "";
    const scopeList: string[] = Array.isArray(oauthConfig?.scopes)
      ? oauthConfig.scopes
      : typeof storedTokens?.scope === "string"
        ? storedTokens.scope.split(/\s+/)
        : [];
    return { clientId, scopes: scopeList.filter(Boolean).join(" ") };
  } catch {
    return { clientId: "", scopes: "" };
  }
};

const toUrlString = (value?: string | URL): string => {
  if (!value) return "";
  if (typeof value === "string") return value;
  try {
    return value.toString();
  } catch {
    return "";
  }
};

const normalizeOAuthProfile = (
  profile?: Partial<OAuthTestProfile> | null,
): OAuthTestProfile => ({
  ...EMPTY_OAUTH_TEST_PROFILE,
  ...(profile ?? {}),
  customHeaders: Array.isArray(profile?.customHeaders)
    ? profile.customHeaders
    : [],
});

export const deriveOAuthProfileFromServer = (
  server?: ServerWithName,
): OAuthTestProfile => {
  if (!server) return EMPTY_OAUTH_TEST_PROFILE;

  const httpConfig =
    "url" in server.config ? (server.config as HttpServerConfig) : null;
  const baseProfile = normalizeOAuthProfile(server.oauthFlowProfile);

  if (!httpConfig) {
    return baseProfile;
  }

  const fallbackHeaders = Object.entries(
    (httpConfig.requestInit?.headers as Record<string, string>) || {},
  ).map(([key, value]) => ({ key, value: String(value) }));

  const scopesFromConfig = Array.isArray((httpConfig as any).oauthScopes)
    ? ((httpConfig as any).oauthScopes as string[]).join(" ")
    : "";

  const clientIdFromConfig =
    typeof (httpConfig as any).clientId === "string"
      ? (httpConfig as any).clientId
      : "";
  const clientSecretFromConfig =
    typeof (httpConfig as any).clientSecret === "string"
      ? (httpConfig as any).clientSecret
      : "";

  const stored = readStoredOAuthCredentials(server.name);

  return {
    ...EMPTY_OAUTH_TEST_PROFILE,
    ...baseProfile,
    serverUrl: baseProfile.serverUrl || toUrlString(httpConfig.url),
    clientId: baseProfile.clientId || clientIdFromConfig || stored.clientId,
    clientSecret: baseProfile.clientSecret || clientSecretFromConfig,
    scopes: baseProfile.scopes || scopesFromConfig || stored.scopes,
    customHeaders: baseProfile.customHeaders.length
      ? baseProfile.customHeaders
      : fallbackHeaders,
  };
};
