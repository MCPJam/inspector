/**
 * OAuth Integration Utility
 * Provides a complete OAuth integration for MCP Inspector
 */

import { MCPOAuthConfig, OAuthClientState, OAUTH_SCOPES } from "./oauth-types";
import { OAuthFlowManager, createOAuthFlow } from "./oauth-flow";
import { tokenManager, OAuthSecurityValidator } from "./oauth-security";
import { discoverMCPOAuth } from "./oauth-discovery";
import { HttpServerDefinition } from "./types";
import { getOAuthCallbackUrl } from "./url-utils";

export interface OAuthIntegrationOptions {
  serverName: string;
  serverUrl: string;
  scopes?: string[];
  redirectUri?: string;
  autoRegister?: boolean;
  securityValidation?: boolean;
}

export interface OAuthIntegrationResult {
  success: boolean;
  serverConfig?: HttpServerDefinition;
  authorizationUrl?: string;
  error?: string;
  warnings?: string[];
}

/**
 * Complete OAuth Integration for MCP Inspector
 * Handles discovery, registration, authorization, and token management
 */
export class MCPOAuthIntegration {
  private flows = new Map<string, OAuthFlowManager>();
  private options: Required<OAuthIntegrationOptions>;

  constructor(options: OAuthIntegrationOptions) {
    this.options = {
      scopes: [OAUTH_SCOPES.MCP_FULL],
      redirectUri: getOAuthCallbackUrl(),
      autoRegister: true,
      securityValidation: true,
      ...options,
    };
  }

  /**
   * Initiates OAuth flow for MCP server
   */
  async initiate(): Promise<OAuthIntegrationResult> {
    try {
      // Security validation
      if (this.options.securityValidation) {
        const validation = OAuthSecurityValidator.validateOAuthConfig({
          redirectUri: this.options.redirectUri,
          scopes: this.options.scopes,
        });

        if (!validation.valid) {
          return {
            success: false,
            error: `Security validation failed: ${validation.errors.join(", ")}`,
            warnings: validation.warnings,
          };
        }
      }

      // Create OAuth flow
      const flow = createOAuthFlow(this.options.serverUrl, {
        client_name: `MCP Inspector - ${this.options.serverName}`,
        requested_scopes: this.options.scopes,
        redirect_uri: this.options.redirectUri,
        auto_register: this.options.autoRegister,
      });

      // Store flow for later use
      this.flows.set(this.options.serverName, flow);

      // Initiate OAuth flow
      const result = await flow.initiate();

      if (result.success && result.authorization_url) {
        return {
          success: true,
          authorizationUrl: result.authorization_url,
        };
      } else {
        return {
          success: false,
          error: result.error?.error_description || "OAuth initiation failed",
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown OAuth error",
      };
    }
  }

  /**
   * Handles OAuth callback and creates server configuration
   */
  async handleCallback(callbackUrl: string): Promise<OAuthIntegrationResult> {
    try {
      const flow = this.flows.get(this.options.serverName);
      if (!flow) {
        return {
          success: false,
          error: "OAuth flow not found. Please restart the connection process.",
        };
      }

      // Handle callback and exchange code for tokens
      const tokenResult = await flow.handleCallback(callbackUrl);

      if (!tokenResult.success || !tokenResult.tokens) {
        return {
          success: false,
          error:
            tokenResult.error?.error_description || "Token exchange failed",
        };
      }

      // Store tokens securely
      await tokenManager.storeTokens(
        this.options.serverName,
        tokenResult.tokens,
      );

      // Create server configuration with OAuth
      const serverConfig = this.createServerConfig(flow.getState());

      return {
        success: true,
        serverConfig,
      };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown callback error",
      };
    }
  }

  /**
   * Gets current OAuth state for a server
   */
  getOAuthState(serverName: string): OAuthClientState | null {
    const flow = this.flows.get(serverName);
    return flow ? flow.getState() : null;
  }

  /**
   * Refreshes OAuth token for a server
   */
  async refreshToken(serverName: string): Promise<boolean> {
    try {
      const flow = this.flows.get(serverName);
      if (!flow) return false;

      const result = await flow.refreshToken();
      if (result.success && result.tokens) {
        await tokenManager.storeTokens(serverName, result.tokens);
        return true;
      }

      return false;
    } catch (error) {
      console.error("Token refresh failed:", error);
      return false;
    }
  }

  /**
   * Creates MCP server configuration with OAuth
   */
  private createServerConfig(
    oauthState: OAuthClientState,
  ): HttpServerDefinition {
    return {
      url: new URL(this.options.serverUrl),
      requestInit: {
        headers: oauthState.access_token
          ? {
              Authorization: `Bearer ${oauthState.access_token}`,
            }
          : {},
      },
      oauth: oauthState,
    };
  }

  /**
   * Disconnects OAuth session
   */
  async disconnect(serverName: string): Promise<void> {
    // Remove stored tokens
    await tokenManager.removeTokens(serverName);

    // Remove OAuth flow
    this.flows.delete(serverName);
  }

  /**
   * Static method to discover OAuth capabilities
   */
  static async discoverOAuthCapabilities(serverUrl: string): Promise<{
    supportsOAuth: boolean;
    capabilities?: string[];
    endpoints?: {
      authorization?: string;
      token?: string;
      registration?: string;
    };
    error?: string;
  }> {
    try {
      const discoveryResult = await discoverMCPOAuth(serverUrl);

      if (discoveryResult.error) {
        return {
          supportsOAuth: false,
          error: discoveryResult.error.error_description,
        };
      }

      const authServer =
        discoveryResult.authorization_server?.authorization_server_metadata;
      const protectedResource =
        discoveryResult.protected_resource?.protected_resource_metadata;

      if (!authServer && !protectedResource) {
        return {
          supportsOAuth: false,
          error: "No OAuth metadata discovered",
        };
      }

      return {
        supportsOAuth: true,
        capabilities: [
          ...(authServer?.mcp_capabilities || []),
          ...(protectedResource?.mcp_capabilities || []),
        ],
        endpoints: {
          authorization: authServer?.authorization_endpoint,
          token: authServer?.token_endpoint,
          registration: authServer?.registration_endpoint,
        },
      };
    } catch (error) {
      return {
        supportsOAuth: false,
        error: error instanceof Error ? error.message : "Discovery failed",
      };
    }
  }
}

/**
 * Utility function to create OAuth-enabled server configuration
 */
export async function createOAuthServerConfig(
  serverName: string,
  serverUrl: string,
  options: Partial<OAuthIntegrationOptions> = {},
): Promise<OAuthIntegrationResult> {
  const integration = new MCPOAuthIntegration({
    serverName,
    serverUrl,
    ...options,
  });

  return await integration.initiate();
}

/**
 * Utility function to check if a server supports OAuth
 */
export async function checkOAuthSupport(serverUrl: string): Promise<boolean> {
  const result = await MCPOAuthIntegration.discoverOAuthCapabilities(serverUrl);
  return result.supportsOAuth;
}

/**
 * Utility function to get valid access token for a server
 */
export async function getValidAccessToken(
  serverName: string,
  refreshCallback?: (refreshToken: string) => Promise<any>,
): Promise<string | null> {
  const tokens = await tokenManager.getValidTokens(serverName, refreshCallback);
  return tokens?.access_token || null;
}

/**
 * Default OAuth configuration for MCP Inspector
 */
export const DEFAULT_MCP_OAUTH_CONFIG: Partial<MCPOAuthConfig> = {
  use_pkce: true,
  pkce_method: "S256",
  requested_scopes: [OAUTH_SCOPES.MCP_FULL],
  discovery_timeout: 10000,
  registration_timeout: 30000,
  token_timeout: 30000,
};

export { MCPOAuthIntegration as default };
