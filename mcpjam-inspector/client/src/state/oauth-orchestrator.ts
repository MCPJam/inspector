import {
  clearOAuthData,
  getStoredTokens,
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

function parseOAuthScopes(scopes?: string | string[]): string[] | undefined {
  const parsed = Array.isArray(scopes)
    ? scopes
    : scopes?.split(/[,\s]+/);
  const normalized = parsed?.map((scope) => scope.trim()).filter(Boolean);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function sanitizeOAuthSetupHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;

  const sanitized = Object.fromEntries(
    Object.entries(headers).filter(
      ([key, value]) =>
        key.toLowerCase() !== "authorization" &&
        typeof value === "string" &&
        value !== "",
    ),
  );
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function readStoredClientInfo(serverName: string): {
  client_id?: string;
  client_secret?: string;
} {
  try {
    const raw = localStorage.getItem(`mcp-client-${serverName}`);
    if (!raw) return {};

    const parsed = JSON.parse(raw);
    return {
      client_id: nonEmptyString(parsed?.client_id),
      client_secret: nonEmptyString(parsed?.client_secret),
    };
  } catch {
    return {};
  }
}

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers) return undefined;

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return sanitizeOAuthSetupHeaders(Object.fromEntries(headers.entries()));
  }

  if (Array.isArray(headers)) {
    const entries = headers.filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    );
    return sanitizeOAuthSetupHeaders(Object.fromEntries(entries));
  }

  if (typeof headers === "object") {
    const entries = Object.entries(headers).filter(
      ([, value]): value is string => typeof value === "string",
    );
    return sanitizeOAuthSetupHeaders(Object.fromEntries(entries));
  }

  return undefined;
}

function profileHeadersToRecord(
  headers?: Array<{ key: string; value: string }>,
): Record<string, string> | undefined {
  const entries = headers
    ?.map(({ key, value }) => [key.trim(), value] as const)
    .filter(([key, value]) => key && value);
  return entries && entries.length > 0
    ? sanitizeOAuthSetupHeaders(Object.fromEntries(entries))
    : undefined;
}

function buildReconnectOAuthOptions(
  server: ServerWithName,
  serverUrl: string,
): MCPOAuthOptions {
  const oauthConfig = readStoredOAuthConfig(server.name);
  const storedClientInfo = readStoredClientInfo(server.name);
  const storedTokens = getStoredTokens(server.name);
  const profile = server.oauthFlowProfile;
  const protocolMode =
    profile?.protocolVersion ?? oauthConfig.protocolMode ?? "auto";
  const registrationMode =
    profile?.registrationStrategy ?? oauthConfig.registrationMode ?? "auto";
  const profileScopes = parseOAuthScopes(profile?.scopes);

  return {
    serverName: server.name,
    serverUrl,
    scopes: profileScopes ?? oauthConfig.scopes,
    resourceUrl: nonEmptyString(profile?.resourceUrl) ?? oauthConfig.resourceUrl,
    customHeaders:
      profileHeadersToRecord(profile?.customHeaders) ??
      normalizeHeaders((server.config as any)?.requestInit?.headers) ??
      sanitizeOAuthSetupHeaders(oauthConfig.customHeaders),
    registryServerId: oauthConfig.registryServerId,
    useRegistryOAuthProxy: oauthConfig.useRegistryOAuthProxy,
    clientId:
      nonEmptyString(server.oauthTokens?.client_id) ??
      nonEmptyString(profile?.clientId) ??
      nonEmptyString(storedTokens?.client_id) ??
      storedClientInfo.client_id,
    clientSecret:
      nonEmptyString(server.oauthTokens?.client_secret) ??
      nonEmptyString(profile?.clientSecret) ??
      storedClientInfo.client_secret,
    protocolMode,
    protocolVersion:
      protocolMode !== "auto"
        ? protocolMode
        : profile?.protocolVersion ?? oauthConfig.protocolVersion,
    registrationMode,
    registrationStrategy:
      registrationMode !== "auto"
        ? registrationMode
        : profile?.registrationStrategy ?? oauthConfig.registrationStrategy,
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
    const opts = buildReconnectOAuthOptions(server, url);
    clearOAuthData(server.name);
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
