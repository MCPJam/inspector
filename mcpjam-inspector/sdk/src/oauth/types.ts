/**
 * @mcpjam/sdk/oauth - OAuth type definitions for MCP server authentication
 *
 * MCP servers require OAuth 2.1 authentication per the MCP Authorization spec.
 * These types support both interactive (browser) and programmatic (CI/CD) flows.
 */

/**
 * OAuth tokens obtained from an OAuth flow.
 */
export interface OAuthTokens {
  /** The access token for API requests */
  accessToken: string;

  /** The refresh token for obtaining new access tokens */
  refreshToken: string;

  /** When the access token expires */
  expiresAt?: Date;

  /** Token type (usually "Bearer") */
  tokenType?: string;

  /** OAuth scopes granted */
  scope?: string;
}

/**
 * Callback invoked when tokens are refreshed.
 * Use this to persist new tokens for future runs.
 */
export type OnTokenRefreshCallback = (
  tokens: OAuthTokens,
) => void | Promise<void>;

/**
 * Configuration for creating a token-based auth provider.
 * Used for programmatic/CI/CD environments where you already have tokens.
 */
export interface TokenAuthProviderOptions {
  /** The access token from a previous OAuth flow */
  accessToken: string;

  /** The refresh token for obtaining new access tokens */
  refreshToken: string;

  /** Callback when tokens are refreshed (for persistence) */
  onTokenRefresh?: OnTokenRefreshCallback;

  /** Custom token endpoint (auto-discovered via RFC 9728 if not provided) */
  tokenEndpoint?: string;

  /** Client ID for confidential clients */
  clientId?: string;

  /** Client secret for confidential clients */
  clientSecret?: string;
}

/**
 * Configuration for interactive OAuth with browser redirect.
 * Used for development environments.
 */
export interface InteractiveAuthProviderOptions {
  /** Callback to handle the OAuth redirect URL (e.g., open in browser) */
  onRedirect: (url: string) => void | Promise<void>;

  /** Callback when tokens are obtained */
  onTokens?: OnTokenRefreshCallback;

  /** Custom authorization endpoint (auto-discovered if not provided) */
  authorizationEndpoint?: string;

  /** Custom token endpoint (auto-discovered if not provided) */
  tokenEndpoint?: string;

  /** Client ID (auto-discovered from MCP server if not provided) */
  clientId?: string;

  /** Redirect URI for the OAuth callback */
  redirectUri?: string;

  /** OAuth scopes to request */
  scopes?: string[];

  /** Port for local callback server (default: auto-assigned) */
  callbackPort?: number;
}

/**
 * OAuth metadata from RFC 9728 discovery.
 * Retrieved from /.well-known/oauth-authorization-server
 */
export interface OAuthMetadata {
  /** The authorization endpoint URL */
  authorization_endpoint: string;

  /** The token endpoint URL */
  token_endpoint: string;

  /** The issuer identifier */
  issuer: string;

  /** Supported response types */
  response_types_supported?: string[];

  /** Supported grant types */
  grant_types_supported?: string[];

  /** Token endpoint auth methods supported */
  token_endpoint_auth_methods_supported?: string[];

  /** Revocation endpoint (if supported) */
  revocation_endpoint?: string;

  /** Introspection endpoint (if supported) */
  introspection_endpoint?: string;

  /** PKCE code challenge methods supported */
  code_challenge_methods_supported?: string[];

  /** Scopes supported */
  scopes_supported?: string[];
}

/**
 * Auth provider interface compatible with MCPClientManager.
 * Implementations handle token management and request authentication.
 */
export interface AuthProvider {
  /**
   * Get the current access token.
   * May trigger a refresh if the token is expired.
   */
  getAccessToken(): Promise<string>;

  /**
   * Check if authentication is available/valid.
   */
  isAuthenticated(): Promise<boolean>;

  /**
   * Handle a 401 response by refreshing tokens.
   * Returns true if refresh succeeded and request should be retried.
   */
  handleUnauthorized?(): Promise<boolean>;

  /**
   * Get authorization headers for requests.
   */
  getHeaders(): Promise<Record<string, string>>;
}

/**
 * Result from a token refresh operation.
 */
export interface TokenRefreshResult {
  /** Whether the refresh was successful */
  success: boolean;

  /** New tokens if successful */
  tokens?: OAuthTokens;

  /** Error message if failed */
  error?: string;
}
