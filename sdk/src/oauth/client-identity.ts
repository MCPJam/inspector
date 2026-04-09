import type {
  OAuthDynamicRegistrationMetadata,
  OAuthProtocolVersion,
} from "./state-machines/types.js";

export const MCPJAM_LOGO_URI = "https://www.mcpjam.com/mcp_jam_2row.png";
export const DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL =
  "https://www.mcpjam.com/.well-known/oauth/client-metadata.json";
export const MCPJAM_CLIENT_URI = "https://github.com/MCPJam/inspector";

const BROWSER_DEBUG_CLIENT_NAMES: Record<OAuthProtocolVersion, string> = {
  "2025-03-26": "MCP Inspector Debug Client",
  "2025-06-18": "MCPJam Inspector Debug Client",
  "2025-11-25": "MCPJam Inspector Debug Client",
};

export function getBrowserDebugDynamicRegistrationMetadata(
  protocolVersion: OAuthProtocolVersion,
): Partial<OAuthDynamicRegistrationMetadata> {
  return {
    client_name: BROWSER_DEBUG_CLIENT_NAMES[protocolVersion],
    client_uri: MCPJAM_CLIENT_URI,
    logo_uri: MCPJAM_LOGO_URI,
  };
}

export function getConformanceAuthCodeDynamicRegistrationMetadata(): Partial<OAuthDynamicRegistrationMetadata> {
  return {
    client_name: "MCPJam SDK OAuth Conformance",
    client_uri: MCPJAM_CLIENT_URI,
    logo_uri: MCPJAM_LOGO_URI,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export function getConformanceClientCredentialsDynamicRegistrationMetadata(): Partial<OAuthDynamicRegistrationMetadata> {
  return {
    client_name: "MCPJam SDK OAuth Conformance",
    client_uri: MCPJAM_CLIENT_URI,
    logo_uri: MCPJAM_LOGO_URI,
    grant_types: ["client_credentials"],
    token_endpoint_auth_method: "client_secret_post",
  };
}
