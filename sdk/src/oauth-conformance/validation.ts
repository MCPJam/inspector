import { withAbortSignalFetch } from "../abort-signal.js";
import { DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL } from "../oauth/client-identity.js";
import { getSupportedRegistrationStrategies } from "../oauth/state-machines/factory.js";
import {
  MCP_OAUTH_READINESS_IDS,
  type NormalizedOAuthConformanceConfig,
  type OAuthConformanceAuthConfig,
  type OAuthConformanceClientConfig,
  type OAuthConformanceConfig,
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
    config.registrationStrategy === "cimd" &&
    !getSupportedRegistrationStrategies(config.protocolVersion).includes("cimd")
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
    signal: config.signal,
    fetchFn: withAbortSignalFetch(config.fetchFn ?? fetch, config.signal),
    allowPrivateNetwork: config.allowPrivateNetwork ?? false,
    stepTimeout: config.stepTimeout ?? 30_000,
    verification: {
      profile: config.verification?.profile,
      listTools:
        config.verification?.listTools ?? !!config.verification?.callTool,
      callTool: config.verification?.callTool,
      timeout: config.verification?.timeout ?? 30_000,
    },
    oauthConformanceChecks: config.oauthConformanceChecks ?? false,
    ...(config.readinessIds !== undefined
      ? { readinessIds: normalizeReadinessIds(config.readinessIds) }
      : {}),
    onProgress: config.onProgress ?? (() => {}),
  };
}

/** Unlike check ids elsewhere, an empty list stays empty: no advice at all. */
function normalizeReadinessIds(
  readinessIds: NonNullable<OAuthConformanceConfig["readinessIds"]>
): NonNullable<OAuthConformanceConfig["readinessIds"]> {
  const normalized = Array.from(new Set(readinessIds));
  for (const readinessId of normalized) {
    if (!MCP_OAUTH_READINESS_IDS.includes(readinessId)) {
      throw new Error(`Unknown OAuth conformance readiness id: ${readinessId}`);
    }
  }
  return normalized;
}
