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
  protocolVersion: OAuthProtocolVersion
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

// Cross-App Access (ID-JAG) client identity.
// Pinned to draft-ietf-oauth-identity-assertion-authz-grant-04: a client that
// advertises the ID-JAG grant profile MUST include both the Token Exchange
// grant (Client<->IdP leg) and the JWT Bearer grant (Client<->RAS leg).
export const ID_JAG_GRANT_PROFILE =
  "urn:ietf:params:oauth:grant-profile:id-jag";
export const TOKEN_EXCHANGE_GRANT =
  "urn:ietf:params:oauth:grant-type:token-exchange";
export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
export const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
export const ID_TOKEN_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";
// Draft §4.3 alternative subject-token type: a signed SAML 2.0 assertion
// (base64 of the XML) representing the requesting client's SSO session.
export const SAML2_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:saml2";

// The XAA debugger's Client ID Metadata Document. This is a DIFFERENT client
// identity from DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL (the authorization-code
// login client); changing that document's grants would change the login
// client, so XAA publishes its own document.
export const XAA_DEBUG_CLIENT_ID_METADATA_URL =
  "https://app.mcpjam.com/.well-known/oauth/xaa-client-metadata.json";

// Client identity registered at MCPJam's mock IdP for the RFC 8693
// Client-to-IdP exchange. This is deliberately distinct from the client
// identity carried in the resulting ID-JAG, which belongs to the RAS.
export const XAA_DEBUG_IDP_CLIENT_ID = "mcpjam-xaa-debugger";

export function getXaaDebugClientMetadata(options: {
  tokenEndpointAuthMethod: "client_secret_post" | "none";
}): Partial<OAuthDynamicRegistrationMetadata> {
  return {
    client_name: "MCPJam XAA Debugger",
    client_uri: MCPJAM_CLIENT_URI,
    logo_uri: MCPJAM_LOGO_URI,
    authorization_grant_profiles_supported: [ID_JAG_GRANT_PROFILE],
    grant_types: [TOKEN_EXCHANGE_GRANT, JWT_BEARER_GRANT],
    token_endpoint_auth_method: options.tokenEndpointAuthMethod,
    // Deliberately NO redirect_uris/response_types - jwt-bearer has no redirect.
  };
}

export type IdJagMetadataEvidence = "present" | "omitted" | "contradicted";

export interface IdJagClientMetadataEvaluation {
  profile: IdJagMetadataEvidence;
  jwtBearerGrant: IdJagMetadataEvidence;
  tokenExchangeGrant: IdJagMetadataEvidence;
  /** Raw value; auth-method policy is the caller's. */
  tokenEndpointAuthMethod: string | undefined;
}

function classifyListMembership(
  value: unknown,
  expected: string
): IdJagMetadataEvidence {
  if (value === undefined || value === null) {
    return "omitted";
  }
  if (Array.isArray(value) && value.includes(expected)) {
    return "present";
  }
  // The property exists but the expected value does not: an explicit
  // statement, not an omission.
  return "contradicted";
}

/**
 * Classifies ID-JAG client-metadata evidence in a DCR response or a Client ID
 * Metadata Document. Evidence only - policy differs by caller: RFC 7591 lets
 * an AS ignore unknown request metadata, so a DCR response may treat
 * "omitted" as a warning, while a CIMD document is the authoritative client
 * metadata and "omitted" means the document is insufficient.
 */
export function evaluateIdJagClientMetadata(
  metadata: Record<string, unknown>
): IdJagClientMetadataEvaluation {
  return {
    profile: classifyListMembership(
      metadata.authorization_grant_profiles_supported,
      ID_JAG_GRANT_PROFILE
    ),
    jwtBearerGrant: classifyListMembership(
      metadata.grant_types,
      JWT_BEARER_GRANT
    ),
    tokenExchangeGrant: classifyListMembership(
      metadata.grant_types,
      TOKEN_EXCHANGE_GRANT
    ),
    tokenEndpointAuthMethod:
      typeof metadata.token_endpoint_auth_method === "string"
        ? metadata.token_endpoint_auth_method
        : undefined,
  };
}
