/**
 * OAuth 2.1 Authorization Flow Implementation
 * Orchestrates the complete OAuth flow for MCP servers
 */

import {
  MCPOAuthConfig,
  OAuthClientState,
  AuthorizationRequest,
  TokenRequest,
  TokenResponse,
  OAuthError,
  OAUTH_SCOPES,
  GRANT_TYPES,
  RESPONSE_TYPES,
  MCP_OAUTH_ERRORS,
  OAUTH_ERRORS,
  PKCE_METHODS,
} from "./oauth-types";

import { discoverMCPOAuth } from "./oauth-discovery";
import {
  registerOAuthClient,
  getDefaultRegistrationOptions,
} from "./oauth-registration";
import {
  generatePKCEParams,
  generateState,
  createAuthorizationUrl,
  parseAuthorizationCallback,
  pkceStorage,
} from "./pkce";

export interface OAuthFlowOptions {
  discovery_timeout?: number;
  registration_timeout?: number;
  token_timeout?: number;
  redirect_uri?: string;
  scopes?: string[];
  auto_register?: boolean;
  save_tokens?: boolean;
}

export interface OAuthFlowResult {
  success: boolean;
  state?: OAuthClientState;
  authorization_url?: string;
  error?: OAuthError;
}

export interface TokenExchangeResult {
  success: boolean;
  tokens?: TokenResponse;
  error?: OAuthError;
}

/**
 * Main OAuth Flow Manager
 * Handles the complete OAuth 2.1 + PKCE flow for MCP servers
 */
export class OAuthFlowManager {
  private config: MCPOAuthConfig;
  private state: OAuthClientState;
  private options: OAuthFlowOptions;

  constructor(config: MCPOAuthConfig, options: OAuthFlowOptions = {}) {
    this.config = config;
    this.options = {
      discovery_timeout: 10000,
      registration_timeout: 30000,
      token_timeout: 30000,
      redirect_uri: "http://localhost:3000/oauth/callback",
      scopes: [OAUTH_SCOPES.MCP_FULL],
      auto_register: true,
      save_tokens: true,
      ...options,
    };

    this.state = {
      connection_status: "disconnected",
    };
  }

  /**
   * Initiates the OAuth flow
   * Returns authorization URL for user to visit
   */
  async initiate(): Promise<OAuthFlowResult> {
    try {
      this.state.connection_status = "discovering";

      // Step 1: Discovery
      const discoveryResult = await this.performDiscovery();
      if (!discoveryResult.success) {
        return discoveryResult;
      }

      // Step 2: Client Registration (if needed)
      if (this.options.auto_register || !this.config.client_id) {
        this.state.connection_status = "registering";
        const registrationResult = await this.performRegistration();
        if (!registrationResult.success) {
          return registrationResult;
        }
      }

      // Step 3: Generate authorization URL
      this.state.connection_status = "authorizing";
      const authorizationResult = await this.generateAuthorizationUrl();

      return authorizationResult;
    } catch (error) {
      this.state.connection_status = "error";
      this.state.last_error = {
        error: OAUTH_ERRORS.SERVER_ERROR,
        error_description:
          error instanceof Error
            ? error.message
            : "Unknown error in OAuth flow",
      };

      return {
        success: false,
        state: this.state,
        error: this.state.last_error,
      };
    }
  }

  /**
   * Handles the authorization callback and exchanges code for tokens
   */
  async handleCallback(callbackUrl: string): Promise<TokenExchangeResult> {
    try {
      // Parse callback parameters
      const callbackParams = parseAuthorizationCallback(callbackUrl);

      if (callbackParams.error) {
        const error: OAuthError = {
          error: callbackParams.error,
          error_description: callbackParams.error_description,
          error_uri: callbackParams.error_uri,
        };

        this.state.connection_status = "error";
        this.state.last_error = error;

        return {
          success: false,
          error,
        };
      }

      if (!callbackParams.code) {
        const error: OAuthError = {
          error: OAUTH_ERRORS.INVALID_REQUEST,
          error_description: "Authorization code not found in callback",
        };

        this.state.connection_status = "error";
        this.state.last_error = error;

        return {
          success: false,
          error,
        };
      }

      // Validate state parameter (CSRF protection)
      if (this.state.authorization_request?.state !== callbackParams.state) {
        const error: OAuthError = {
          error: OAUTH_ERRORS.INVALID_REQUEST,
          error_description: "State parameter mismatch (CSRF protection)",
        };

        this.state.connection_status = "error";
        this.state.last_error = error;

        return {
          success: false,
          error,
        };
      }

      // Exchange code for tokens
      const tokenResult = await this.exchangeCodeForTokens(callbackParams.code);

      if (tokenResult.success && tokenResult.tokens) {
        this.state.connection_status = "connected";

        // Store tokens
        this.state.access_token = tokenResult.tokens.access_token;
        this.state.token_type = tokenResult.tokens.token_type;
        this.state.refresh_token = tokenResult.tokens.refresh_token;
        this.state.scope = tokenResult.tokens.scope;

        // Calculate expiration
        if (tokenResult.tokens.expires_in) {
          this.state.expires_at =
            Date.now() + tokenResult.tokens.expires_in * 1000;
        }
      } else {
        this.state.connection_status = "error";
        this.state.last_error = tokenResult.error;
      }

      return tokenResult;
    } catch (error) {
      const oauthError: OAuthError = {
        error: OAUTH_ERRORS.SERVER_ERROR,
        error_description:
          error instanceof Error
            ? error.message
            : "Unknown error in callback handling",
      };

      this.state.connection_status = "error";
      this.state.last_error = oauthError;

      return {
        success: false,
        error: oauthError,
      };
    }
  }

  /**
   * Refreshes access token using refresh token
   */
  async refreshToken(): Promise<TokenExchangeResult> {
    if (!this.state.refresh_token) {
      const error: OAuthError = {
        error: OAUTH_ERRORS.INVALID_REQUEST,
        error_description: "No refresh token available",
      };

      return {
        success: false,
        error,
      };
    }

    if (!this.state.authorization_server_metadata?.token_endpoint) {
      const error: OAuthError = {
        error: OAUTH_ERRORS.SERVER_ERROR,
        error_description: "Token endpoint not available",
      };

      return {
        success: false,
        error,
      };
    }

    try {
      const tokenRequest: TokenRequest = {
        grant_type: GRANT_TYPES.REFRESH_TOKEN,
        refresh_token: this.state.refresh_token,
        client_id: this.getClientId(),
        scope: this.state.scope,
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.options.token_timeout,
      );

      const response = await fetch(
        this.state.authorization_server_metadata.token_endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": "MCP-Inspector/1.0",
          },
          body: this.encodeTokenRequest(tokenRequest),
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (response.ok) {
        const tokens = (await response.json()) as TokenResponse;

        // Update stored tokens
        this.state.access_token = tokens.access_token;
        this.state.token_type = tokens.token_type;
        if (tokens.refresh_token) {
          this.state.refresh_token = tokens.refresh_token;
        }
        this.state.scope = tokens.scope;

        if (tokens.expires_in) {
          this.state.expires_at = Date.now() + tokens.expires_in * 1000;
        }

        return {
          success: true,
          tokens,
        };
      } else {
        let error: OAuthError;
        try {
          error = (await response.json()) as OAuthError;
        } catch {
          error = {
            error: OAUTH_ERRORS.SERVER_ERROR,
            error_description: `Token refresh failed with status ${response.status}`,
          };
        }

        return {
          success: false,
          error,
        };
      }
    } catch (error) {
      return {
        success: false,
        error: {
          error: OAUTH_ERRORS.SERVER_ERROR,
          error_description:
            error instanceof Error
              ? error.message
              : "Unknown token refresh error",
        },
      };
    }
  }

  /**
   * Checks if access token is expired or expiring soon
   */
  isTokenExpired(bufferMinutes: number = 5): boolean {
    if (!this.state.expires_at) {
      return false; // No expiration time means token doesn't expire
    }

    const bufferMs = bufferMinutes * 60 * 1000;
    return this.state.expires_at - Date.now() < bufferMs;
  }

  /**
   * Gets current access token, refreshing if necessary
   */
  async getValidAccessToken(): Promise<string | null> {
    if (!this.state.access_token) {
      return null;
    }

    if (this.isTokenExpired() && this.state.refresh_token) {
      const refreshResult = await this.refreshToken();
      if (!refreshResult.success) {
        return null;
      }
    }

    return this.state.access_token;
  }

  /**
   * Gets current OAuth state
   */
  getState(): OAuthClientState {
    return { ...this.state };
  }

  /**
   * Resets OAuth state (for logout/disconnect)
   */
  reset(): void {
    this.state = {
      connection_status: "disconnected",
    };
  }

  // Private methods

  private async performDiscovery(): Promise<OAuthFlowResult> {
    const discoveryResult = await discoverMCPOAuth(this.config.server_url, {
      timeout: this.options.discovery_timeout,
    });

    if (discoveryResult.error) {
      this.state.connection_status = "error";
      this.state.last_error = discoveryResult.error;

      return {
        success: false,
        state: this.state,
        error: discoveryResult.error,
      };
    }

    if (discoveryResult.authorization_server?.authorization_server_metadata) {
      this.state.authorization_server_metadata =
        discoveryResult.authorization_server.authorization_server_metadata;
    }

    if (discoveryResult.protected_resource?.protected_resource_metadata) {
      this.state.protected_resource_metadata =
        discoveryResult.protected_resource.protected_resource_metadata;
    }

    return { success: true, state: this.state };
  }

  private async performRegistration(): Promise<OAuthFlowResult> {
    if (!this.state.authorization_server_metadata) {
      const error: OAuthError = {
        error: MCP_OAUTH_ERRORS.REGISTRATION_FAILED,
        error_description:
          "Authorization server metadata not available for registration",
      };

      this.state.connection_status = "error";
      this.state.last_error = error;

      return {
        success: false,
        state: this.state,
        error,
      };
    }

    const registrationOptions = getDefaultRegistrationOptions();
    registrationOptions.redirect_uris = [this.options.redirect_uri!];
    registrationOptions.scopes = this.options.scopes;
    registrationOptions.timeout = this.options.registration_timeout;

    const registrationResult = await registerOAuthClient(
      this.state.authorization_server_metadata,
      registrationOptions,
    );

    if (!registrationResult.success) {
      this.state.connection_status = "error";
      this.state.last_error = registrationResult.error;

      return {
        success: false,
        state: this.state,
        error: registrationResult.error,
      };
    }

    this.state.client_registration = registrationResult.client_registration;

    return { success: true, state: this.state };
  }

  private async generateAuthorizationUrl(): Promise<OAuthFlowResult> {
    if (!this.state.authorization_server_metadata?.authorization_endpoint) {
      const error: OAuthError = {
        error: OAUTH_ERRORS.SERVER_ERROR,
        error_description: "Authorization endpoint not available",
      };

      this.state.connection_status = "error";
      this.state.last_error = error;

      return {
        success: false,
        state: this.state,
        error,
      };
    }

    // Generate PKCE parameters
    const pkceParams = await generatePKCEParams();
    this.state.pkce_params = pkceParams;

    // Generate state for CSRF protection
    const state = generateState();

    // Create authorization request
    const authRequest: AuthorizationRequest = {
      response_type: RESPONSE_TYPES.CODE,
      client_id: this.getClientId(),
      redirect_uri: this.options.redirect_uri,
      scope: this.options.scopes?.join(" "),
      state,
      code_challenge: pkceParams.code_challenge,
      code_challenge_method: PKCE_METHODS.S256,
      resource: this.config.server_url,
    };

    this.state.authorization_request = authRequest;

    // Store PKCE params for later retrieval
    pkceStorage.store(state, pkceParams);

    // Generate authorization URL
    const authorizationUrl = createAuthorizationUrl(
      this.state.authorization_server_metadata.authorization_endpoint,
      authRequest.client_id,
      authRequest.redirect_uri!,
      pkceParams,
      {
        scope: authRequest.scope,
        state: authRequest.state,
        resource: authRequest.resource,
      },
    );

    return {
      success: true,
      state: this.state,
      authorization_url: authorizationUrl,
    };
  }

  private async exchangeCodeForTokens(
    code: string,
  ): Promise<TokenExchangeResult> {
    if (!this.state.authorization_server_metadata?.token_endpoint) {
      return {
        success: false,
        error: {
          error: OAUTH_ERRORS.SERVER_ERROR,
          error_description: "Token endpoint not available",
        },
      };
    }

    if (!this.state.pkce_params) {
      return {
        success: false,
        error: {
          error: OAUTH_ERRORS.INVALID_REQUEST,
          error_description: "PKCE parameters not found",
        },
      };
    }

    try {
      const tokenRequest: TokenRequest = {
        grant_type: GRANT_TYPES.AUTHORIZATION_CODE,
        code,
        redirect_uri: this.options.redirect_uri,
        client_id: this.getClientId(),
        code_verifier: this.state.pkce_params.code_verifier,
        resource: this.config.server_url,
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.options.token_timeout,
      );

      const response = await fetch(
        this.state.authorization_server_metadata.token_endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
            "User-Agent": "MCP-Inspector/1.0",
          },
          body: this.encodeTokenRequest(tokenRequest),
          signal: controller.signal,
        },
      );

      clearTimeout(timeoutId);

      if (response.ok) {
        const tokens = (await response.json()) as TokenResponse;
        return {
          success: true,
          tokens,
        };
      } else {
        let error: OAuthError;
        try {
          error = (await response.json()) as OAuthError;
        } catch {
          error = {
            error: OAUTH_ERRORS.SERVER_ERROR,
            error_description: `Token exchange failed with status ${response.status}`,
          };
        }

        return {
          success: false,
          error,
        };
      }
    } catch (error) {
      return {
        success: false,
        error: {
          error: OAUTH_ERRORS.SERVER_ERROR,
          error_description:
            error instanceof Error
              ? error.message
              : "Unknown token exchange error",
        },
      };
    }
  }

  private getClientId(): string {
    return (
      this.state.client_registration?.client_id || this.config.client_id || ""
    );
  }

  private encodeTokenRequest(request: TokenRequest): string {
    const params = new URLSearchParams();

    Object.entries(request).forEach(([key, value]) => {
      if (value !== undefined) {
        if (Array.isArray(value)) {
          value.forEach((v) => params.append(key, v));
        } else {
          params.set(key, value.toString());
        }
      }
    });

    return params.toString();
  }
}

/**
 * Creates an OAuth flow manager with default configuration
 */
export function createOAuthFlow(
  serverUrl: string,
  options: Partial<MCPOAuthConfig & OAuthFlowOptions> = {},
): OAuthFlowManager {
  const config: MCPOAuthConfig = {
    server_url: serverUrl,
    client_name: "MCP Inspector",
    client_description: "Interactive MCP Server Inspector",
    use_pkce: true,
    pkce_method: "S256",
    requested_scopes: [OAUTH_SCOPES.MCP_FULL],
    discovery_timeout: 10000,
    registration_timeout: 30000,
    token_timeout: 30000,
    ...options,
  };

  const flowOptions: OAuthFlowOptions = {
    discovery_timeout: config.discovery_timeout,
    registration_timeout: config.registration_timeout,
    token_timeout: config.token_timeout,
    redirect_uri: "http://localhost:3000/oauth/callback",
    scopes: config.requested_scopes,
    auto_register: true,
    save_tokens: true,
    ...options,
  };

  return new OAuthFlowManager(config, flowOptions);
}
