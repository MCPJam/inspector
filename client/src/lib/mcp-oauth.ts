/**
 * Clean OAuth implementation using only the official MCP SDK with CORS proxy support
 */

import {
  auth,
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { HttpServerDefinition } from "./types";

// Store original fetch for restoration  
const originalFetch = window.fetch;

/**
 * Custom fetch interceptor that proxies OAuth metadata requests through our server
 */
function createOAuthFetchInterceptor(): typeof fetch {
  return async function interceptedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    
    // Check if this is an OAuth metadata request
    if (url.includes('/.well-known/oauth-authorization-server')) {
      try {
        // Proxy through our server to avoid CORS
        const proxyUrl = `/api/mcp/oauth/metadata?url=${encodeURIComponent(url)}`;
        return await originalFetch(proxyUrl, {
          ...init,
          method: 'GET', // Always GET for metadata
        });
      } catch (error) {
        console.error('OAuth metadata proxy failed, falling back to direct fetch:', error);
        // Fallback to original fetch if proxy fails
        return await originalFetch(input, init);
      }
    }
    
    // For all other requests, use original fetch
    return await originalFetch(input, init);
  };
}

export interface MCPOAuthOptions {
  serverName: string;
  serverUrl: string;
  scopes?: string[];
}

export interface OAuthResult {
  success: boolean;
  serverConfig?: HttpServerDefinition;
  error?: string;
}

/**
 * Simple localStorage-based OAuth provider for MCP
 */
class MCPOAuthProvider implements OAuthClientProvider {
  private serverName: string;
  private redirectUri: string;

  constructor(serverName: string) {
    this.serverName = serverName;
    this.redirectUri = `${window.location.origin}/oauth/callback`;
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata() {
    return {
      client_name: `MCP Inspector - ${this.serverName}`,
      client_uri: "https://github.com/modelcontextprotocol/inspector",
      redirect_uris: [this.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      scope: "mcp:*",
    };
  }

  clientInformation() {
    const stored = localStorage.getItem(`mcp-client-${this.serverName}`);
    return stored ? JSON.parse(stored) : undefined;
  }

  async saveClientInformation(clientInformation: any) {
    localStorage.setItem(
      `mcp-client-${this.serverName}`,
      JSON.stringify(clientInformation)
    );
  }

  tokens() {
    const stored = localStorage.getItem(`mcp-tokens-${this.serverName}`);
    return stored ? JSON.parse(stored) : undefined;
  }

  async saveTokens(tokens: any) {
    localStorage.setItem(
      `mcp-tokens-${this.serverName}`,
      JSON.stringify(tokens)
    );
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    // Store server name for callback recovery
    console.log("Setting mcp-oauth-pending to:", this.serverName);
    localStorage.setItem("mcp-oauth-pending", this.serverName);
    window.location.href = authorizationUrl.toString();
  }

  async saveCodeVerifier(codeVerifier: string) {
    localStorage.setItem(`mcp-verifier-${this.serverName}`, codeVerifier);
  }

  codeVerifier(): string {
    const verifier = localStorage.getItem(`mcp-verifier-${this.serverName}`);
    if (!verifier) {
      throw new Error("Code verifier not found");
    }
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier") {
    switch (scope) {
      case "all":
        localStorage.removeItem(`mcp-tokens-${this.serverName}`);
        localStorage.removeItem(`mcp-client-${this.serverName}`);
        localStorage.removeItem(`mcp-verifier-${this.serverName}`);
        break;
      case "client":
        localStorage.removeItem(`mcp-client-${this.serverName}`);
        break;
      case "tokens":
        localStorage.removeItem(`mcp-tokens-${this.serverName}`);
        break;
      case "verifier":
        localStorage.removeItem(`mcp-verifier-${this.serverName}`);
        break;
    }
  }
}

/**
 * Initiates OAuth flow for an MCP server
 */
export async function initiateOAuth(
  options: MCPOAuthOptions
): Promise<OAuthResult> {
  // Install fetch interceptor for OAuth metadata requests
  const interceptedFetch = createOAuthFetchInterceptor();
  window.fetch = interceptedFetch;
  
  try {
    const provider = new MCPOAuthProvider(options.serverName);

    // Store server URL for callback recovery
    localStorage.setItem(
      `mcp-serverUrl-${options.serverName}`,
      options.serverUrl
    );
    localStorage.setItem("mcp-oauth-pending", options.serverName);

    const result = await auth(provider, {
      serverUrl: options.serverUrl,
      scope: options.scopes?.join(" ") || "mcp:*",
    });

    if (result === "REDIRECT") {
      return {
        success: true,
      };
    }

    if (result === "AUTHORIZED") {
      const tokens = provider.tokens();
      if (tokens) {
        const serverConfig = createServerConfig(options.serverUrl, tokens);
        return {
          success: true,
          serverConfig,
        };
      }
    }

    return {
      success: false,
      error: "OAuth flow failed",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown OAuth error",
    };
  } finally {
    // Restore original fetch
    window.fetch = originalFetch;
  }
}

/**
 * Handles OAuth callback and completes the flow
 */
export async function handleOAuthCallback(
  authorizationCode: string
): Promise<OAuthResult & { serverName?: string }> {
  // Install fetch interceptor for OAuth metadata requests
  const interceptedFetch = createOAuthFetchInterceptor();
  window.fetch = interceptedFetch;
  
  try {
    // Get pending server name from localStorage
    const serverName = localStorage.getItem("mcp-oauth-pending");
    if (!serverName) {
      throw new Error("No pending OAuth flow found");
    }

    // Get server URL
    const serverUrl = localStorage.getItem(`mcp-serverUrl-${serverName}`);
    if (!serverUrl) {
      throw new Error("Server URL not found for OAuth callback");
    }

    const provider = new MCPOAuthProvider(serverName);

    const result = await auth(provider, {
      serverUrl,
      authorizationCode,
      scope: "mcp:*",
    });

    if (result === "AUTHORIZED") {
      const tokens = provider.tokens();
      if (tokens) {
        // Clean up pending state
        localStorage.removeItem("mcp-oauth-pending");

        const serverConfig = createServerConfig(serverUrl, tokens);
        return {
          success: true,
          serverConfig,
          serverName, // Return server name so caller doesn't need to look it up
        };
      }
    }

    return {
      success: false,
      error: "Token exchange failed",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown callback error",
    };
  } finally {
    // Restore original fetch
    window.fetch = originalFetch;
  }
}

/**
 * Gets stored tokens for a server
 */
export function getStoredTokens(serverName: string): any {
  const stored = localStorage.getItem(`mcp-tokens-${serverName}`);
  return stored ? JSON.parse(stored) : undefined;
}

/**
 * Waits for tokens to be available with timeout
 */
export async function waitForTokens(
  serverName: string,
  timeoutMs: number = 5000
): Promise<any> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const tokens = getStoredTokens(serverName);
    if (tokens?.access_token) {
      return tokens;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timeout waiting for tokens for server: ${serverName}`);
}

/**
 * Refreshes OAuth tokens for a server using the refresh token
 */
export async function refreshOAuthTokens(
  serverName: string
): Promise<OAuthResult> {
  // Install fetch interceptor for OAuth metadata requests
  const interceptedFetch = createOAuthFetchInterceptor();
  window.fetch = interceptedFetch;
  
  try {
    const provider = new MCPOAuthProvider(serverName);
    const existingTokens = provider.tokens();

    if (!existingTokens?.refresh_token) {
      return {
        success: false,
        error: "No refresh token available",
      };
    }

    // Get server URL
    const serverUrl = localStorage.getItem(`mcp-serverUrl-${serverName}`);
    if (!serverUrl) {
      return {
        success: false,
        error: "Server URL not found for token refresh",
      };
    }

    const result = await auth(provider, {
      serverUrl,
      scope: "mcp:*",
    });

    if (result === "AUTHORIZED") {
      const tokens = provider.tokens();
      if (tokens) {
        const serverConfig = createServerConfig(serverUrl, tokens);
        return {
          success: true,
          serverConfig,
        };
      }
    }

    return {
      success: false,
      error: "Token refresh failed",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown refresh error",
    };
  } finally {
    // Restore original fetch
    window.fetch = originalFetch;
  }
}

/**
 * Clears all OAuth data for a server
 */
export function clearOAuthData(serverName: string): void {
  localStorage.removeItem(`mcp-tokens-${serverName}`);
  localStorage.removeItem(`mcp-client-${serverName}`);
  localStorage.removeItem(`mcp-verifier-${serverName}`);
  localStorage.removeItem(`mcp-serverUrl-${serverName}`);
}

/**
 * Creates MCP server configuration with OAuth tokens
 */
function createServerConfig(
  serverUrl: string,
  tokens: any
): HttpServerDefinition {
  return {
    url: new URL(serverUrl),
    requestInit: {
      headers: tokens.access_token
        ? {
            Authorization: `Bearer ${tokens.access_token}`,
          }
        : {},
    },
    oauth: tokens,
  };
}
