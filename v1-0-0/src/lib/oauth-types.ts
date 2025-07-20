/**
 * OAuth 2.0 + Dynamic Client Registration Types
 * Based on MCP Authorization specification
 */

// RFC 8414: Authorization Server Metadata
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported: string[];
  response_modes_supported?: string[];
  grant_types_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  token_endpoint_auth_signing_alg_values_supported?: string[];
  service_documentation?: string;
  ui_locales_supported?: string[];
  op_policy_uri?: string;
  op_tos_uri?: string;
  revocation_endpoint?: string;
  revocation_endpoint_auth_methods_supported?: string[];
  revocation_endpoint_auth_signing_alg_values_supported?: string[];
  introspection_endpoint?: string;
  introspection_endpoint_auth_methods_supported?: string[];
  introspection_endpoint_auth_signing_alg_values_supported?: string[];
  code_challenge_methods_supported?: string[];
  // MCP-specific extensions
  mcp_version?: string;
  mcp_capabilities?: string[];
}

// RFC 9728: Protected Resource Metadata
export interface ProtectedResourceMetadata {
  resource_server: string;
  authorization_servers?: string[];
  jwks_uri?: string;
  bearer_methods_supported?: string[];
  resource_documentation?: string;
  resource_policy_uri?: string;
  resource_tos_uri?: string;
  // MCP-specific fields
  mcp_version?: string;
  mcp_capabilities?: string[];
  mcp_tools?: string[];
  mcp_resources?: string[];
  mcp_prompts?: string[];
}

// RFC 7591: Dynamic Client Registration
export interface ClientRegistrationRequest {
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  scope?: string;
  contacts?: string[];
  tos_uri?: string;
  policy_uri?: string;
  jwks_uri?: string;
  jwks?: object;
  software_id?: string;
  software_version?: string;
  software_statement?: string;
  // MCP-specific fields
  mcp_version?: string;
  mcp_client_name?: string;
  mcp_client_description?: string;
}

export interface ClientRegistrationResponse {
  client_id: string;
  client_secret?: string;
  registration_access_token?: string;
  registration_client_uri?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  scope?: string;
  contacts?: string[];
  tos_uri?: string;
  policy_uri?: string;
  jwks_uri?: string;
  jwks?: object;
  software_id?: string;
  software_version?: string;
}

// PKCE (RFC 7636)
export interface PKCEParams {
  code_verifier: string;
  code_challenge: string;
  code_challenge_method: "S256" | "plain";
}

// OAuth 2.1 Authorization Request
export interface AuthorizationRequest {
  response_type: "code";
  client_id: string;
  redirect_uri?: string;
  scope?: string;
  state?: string;
  code_challenge: string;
  code_challenge_method: "S256";
  // Resource indicators (RFC 8707)
  resource?: string | string[];
}

// OAuth 2.1 Token Request
export interface TokenRequest {
  grant_type: "authorization_code" | "refresh_token";
  code?: string;
  redirect_uri?: string;
  client_id: string;
  code_verifier?: string;
  refresh_token?: string;
  scope?: string;
  // Resource indicators
  resource?: string | string[];
}

// OAuth 2.1 Token Response
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  // Additional fields
  issued_token_type?: string;
  authorization_details?: AuthorizationDetail[];
}

// RFC 9396: Rich Authorization Requests
export interface AuthorizationDetail {
  type: string;
  locations?: string[];
  actions?: string[];
  datatypes?: string[];
  identifier?: string;
  privileges?: string[];
  // MCP-specific authorization details
  mcp_tools?: string[];
  mcp_resources?: string[];
  mcp_prompts?: string[];
}

// OAuth Error Response
export interface OAuthError {
  error: string;
  error_description?: string;
  error_uri?: string;
  state?: string;
}

// MCP OAuth Configuration
export interface MCPOAuthConfig {
  // Discovery
  server_url: string;
  client_name: string;
  client_description?: string;

  // Optional pre-configured values
  client_id?: string;
  client_secret?: string;
  authorization_server?: string;

  // Scopes and permissions
  requested_scopes?: string[];
  requested_tools?: string[];
  requested_resources?: string[];
  requested_prompts?: string[];

  // PKCE settings
  use_pkce: boolean;
  pkce_method: "S256";

  // Timeouts and retries
  discovery_timeout?: number;
  registration_timeout?: number;
  token_timeout?: number;
}

// OAuth Client State
export interface OAuthClientState {
  // Discovery results
  authorization_server_metadata?: AuthorizationServerMetadata;
  protected_resource_metadata?: ProtectedResourceMetadata;

  // Registration results
  client_registration?: ClientRegistrationResponse;

  // Authorization flow state
  authorization_request?: AuthorizationRequest;
  pkce_params?: PKCEParams;

  // Token state
  access_token?: string;
  token_type?: string;
  expires_at?: number;
  refresh_token?: string;
  scope?: string;

  // Error state
  last_error?: OAuthError;

  // MCP connection state
  connection_status:
    | "disconnected"
    | "discovering"
    | "registering"
    | "authorizing"
    | "connected"
    | "error";
}

// Discovery endpoints
export const WELL_KNOWN_PATHS = {
  AUTHORIZATION_SERVER: "/.well-known/oauth-authorization-server",
  PROTECTED_RESOURCE: "/.well-known/oauth-protected-resource",
  MCP_OAUTH: "/.well-known/mcp-oauth",
} as const;

// Standard OAuth scopes
export const OAUTH_SCOPES = {
  MCP_TOOLS: "mcp:tools",
  MCP_RESOURCES: "mcp:resources",
  MCP_PROMPTS: "mcp:prompts",
  MCP_FULL: "mcp:*",
} as const;

// PKCE code challenge methods
export const PKCE_METHODS = {
  S256: "S256",
  PLAIN: "plain",
} as const;

// OAuth grant types
export const GRANT_TYPES = {
  AUTHORIZATION_CODE: "authorization_code",
  REFRESH_TOKEN: "refresh_token",
} as const;

// OAuth response types
export const RESPONSE_TYPES = {
  CODE: "code",
} as const;

// Token endpoint auth methods
export const TOKEN_ENDPOINT_AUTH_METHODS = {
  CLIENT_SECRET_BASIC: "client_secret_basic",
  CLIENT_SECRET_POST: "client_secret_post",
  NONE: "none",
} as const;

// Standard OAuth errors
export const OAUTH_ERRORS = {
  INVALID_REQUEST: "invalid_request",
  INVALID_CLIENT: "invalid_client",
  INVALID_GRANT: "invalid_grant",
  UNAUTHORIZED_CLIENT: "unauthorized_client",
  UNSUPPORTED_GRANT_TYPE: "unsupported_grant_type",
  INVALID_SCOPE: "invalid_scope",
  ACCESS_DENIED: "access_denied",
  UNSUPPORTED_RESPONSE_TYPE: "unsupported_response_type",
  SERVER_ERROR: "server_error",
  TEMPORARILY_UNAVAILABLE: "temporarily_unavailable",
} as const;

// MCP-specific errors
export const MCP_OAUTH_ERRORS = {
  DISCOVERY_FAILED:
    "OAuth Discovery Failed. Check to make sure a auth server is running.",
  REGISTRATION_FAILED: "OAuth Registration Failed",
  UNSUPPORTED_VERSION: "OAuth Unsupported Version",
  INSUFFICIENT_PERMISSIONS: "OAuth Insufficient Permissions",
} as const;
