import { DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL } from "../oauth/client-identity.js";
import type {
  NormalizedOAuthConformanceConfig,
  OAuthConformanceAuthConfig,
  OAuthConformanceClientConfig,
  OAuthConformanceConfig,
} from "./types.js";

function deriveServerName(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  if (!trimmed) {
    return "oauth-conformance-target";
  }

  try {
    return new URL(trimmed).host || trimmed;
  } catch {
    return trimmed;
  }
}

function normalizeAuthConfig(
  auth: OAuthConformanceConfig["auth"],
): OAuthConformanceAuthConfig {
  return auth ?? { mode: "interactive" };
}

function normalizeClientConfig(
  client: OAuthConformanceConfig["client"],
  registrationStrategy: OAuthConformanceConfig["registrationStrategy"],
): OAuthConformanceClientConfig {
  const normalized = client ?? {};

  if (
    registrationStrategy === "cimd" &&
    !normalized.clientIdMetadataUrl
  ) {
    return {
      ...normalized,
      clientIdMetadataUrl: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
    };
  }

  return normalized;
}

export function normalizeOAuthConformanceConfig(
  config: OAuthConformanceConfig,
): NormalizedOAuthConformanceConfig {
  const serverUrl = config.serverUrl.trim();
  if (!serverUrl) {
    throw new Error("OAuth conformance config requires serverUrl");
  }

  const auth = normalizeAuthConfig(config.auth);
  const client = normalizeClientConfig(
    config.client,
    config.registrationStrategy,
  );

  if (
    config.protocolVersion !== "2025-11-25" &&
    config.registrationStrategy === "cimd"
  ) {
    throw new Error(
      `CIMD registration is not supported for protocol version ${config.protocolVersion}`,
    );
  }

  if (
    auth.mode === "client_credentials" &&
    config.registrationStrategy === "cimd"
  ) {
    throw new Error(
      "client_credentials cannot be used with the cimd registration strategy",
    );
  }

  if (
    config.registrationStrategy === "preregistered" &&
    !client.preregistered?.clientId
  ) {
    throw new Error(
      "client.preregistered.clientId is required for preregistered registration",
    );
  }

  if (
    config.registrationStrategy === "preregistered" &&
    auth.mode === "client_credentials" &&
    !client.preregistered?.clientSecret
  ) {
    throw new Error(
      "client.preregistered.clientSecret is required for preregistered client_credentials runs",
    );
  }

  if (
    config.registrationStrategy === "cimd" &&
    !client.clientIdMetadataUrl
  ) {
    throw new Error(
      "client.clientIdMetadataUrl is required for CIMD registration",
    );
  }

  return {
    serverUrl,
    serverName: deriveServerName(serverUrl),
    protocolVersion: config.protocolVersion,
    registrationStrategy: config.registrationStrategy,
    auth,
    client,
    scopes: config.scopes?.trim() || undefined,
    customHeaders: config.customHeaders,
    redirectUrl: config.redirectUrl,
    fetchFn: config.fetchFn ?? fetch,
    stepTimeout: config.stepTimeout ?? 30_000,
    verification: {
      listTools: config.verification?.listTools ?? !!config.verification?.callTool,
      callTool: config.verification?.callTool,
      timeout: config.verification?.timeout ?? 30_000,
    },
    oauthConformanceChecks: config.oauthConformanceChecks ?? false,
    onProgress: config.onProgress ?? (() => {}),
  };
}
