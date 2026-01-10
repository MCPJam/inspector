import type { ServerWithName } from "@/hooks/use-app-state";
import type { HttpServerDefinition } from "@/shared/types.js";
import {
  EMPTY_OAUTH_TEST_PROFILE,
  type OAuthTestProfile,
} from "@/lib/oauth/profile";

const toUrlString = (value?: string | URL): string => {
  if (!value) return "";
  if (typeof value === "string") return value;
  try {
    return value.toString();
  } catch {
    return "";
  }
};

export const deriveOAuthProfileFromServer = (
  server?: ServerWithName,
): OAuthTestProfile => {
  if (!server) return EMPTY_OAUTH_TEST_PROFILE;

  const httpConfig =
    "url" in server.config ? (server.config as HttpServerDefinition) : null;
  const baseProfile = server.oauthFlowProfile ?? EMPTY_OAUTH_TEST_PROFILE;

  if (!httpConfig) {
    return {
      ...EMPTY_OAUTH_TEST_PROFILE,
      ...baseProfile,
    };
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

  return {
    ...EMPTY_OAUTH_TEST_PROFILE,
    ...baseProfile,
    serverUrl: baseProfile.serverUrl || toUrlString(httpConfig.url),
    clientId: baseProfile.clientId || clientIdFromConfig,
    clientSecret: baseProfile.clientSecret || clientSecretFromConfig,
    scopes: baseProfile.scopes || scopesFromConfig,
    customHeaders: baseProfile.customHeaders.length
      ? baseProfile.customHeaders
      : fallbackHeaders,
  };
};
