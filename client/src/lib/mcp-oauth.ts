/**
 * Clean OAuth implementation using only the official MCP SDK with CORS proxy support
 */

import {
  auth,
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { HttpServerDefinition } from "@/shared/types.js";

// Store original fetch for restoration
const originalFetch = window.fetch;

/**
 * Custom fetch interceptor that proxies OAuth metadata requests through our server
 */
function createOAuthFetchInterceptor(): typeof fetch {
  return async function interceptedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    // Check if this is an OAuth metadata request
    if (url.includes("/.well-known/oauth-authorization-server")) {
      try {
        // Proxy through our server to avoid CORS
        const proxyUrl = `/api/mcp/oauth/metadata?url=${encodeURIComponent(url)}`;
        return await originalFetch(proxyUrl, {
          ...init,
          method: "GET", // Always GET for metadata
        });
      } catch (error) {
        console.error(
          "OAuth metadata proxy failed, falling back to direct fetch:",
          error,
        );
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
  clientId?: string;
}

export interface OAuthResult {
  success: boolean;
  serverConfig?: HttpServerDefinition;
  error?: string;
}

/**
 * Simple localStorage-based OAuth provider for MCP
 */
export class MCPOAuthProvider implements OAuthClientProvider {
  private serverName: string;
  private redirectUri: string;
  private customClientId?: string;

  constructor(serverName: string, customClientId?: string) {
    this.serverName = serverName;
    this.redirectUri = `${window.location.origin}/oauth/callback`;
    this.customClientId = customClientId;
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  get clientMetadata() {
    return {
      client_name: `MCPJam - ${this.serverName}`,
      client_uri: "https://github.com/mcpjam/inspector",
      redirect_uris: [this.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation() {
    const stored = localStorage.getItem(`mcp-client-${this.serverName}`);
    const storedJson = stored ? JSON.parse(stored) : undefined;

    // If custom client ID is provided, use it
    if (this.customClientId) {
      if (storedJson) {
        // If there's stored information, merge with custom client ID
        return {
          ...storedJson,
          client_id: this.customClientId,
        };
      } else {
        // If no stored information, create a minimal client info with custom client ID
        return {
          client_id: this.customClientId,
        };
      }
    }
    return storedJson;
  }

  async saveClientInformation(clientInformation: any) {
    localStorage.setItem(
      `mcp-client-${this.serverName}`,
      JSON.stringify(clientInformation),
    );
  }

  tokens() {
    const stored = localStorage.getItem(`mcp-tokens-${this.serverName}`);
    return stored ? JSON.parse(stored) : undefined;
  }

  async saveTokens(tokens: any) {
    localStorage.setItem(
      `mcp-tokens-${this.serverName}`,
      JSON.stringify(tokens),
    );
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    // Store server name for callback recovery

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
  options: MCPOAuthOptions,
): Promise<OAuthResult> {
  // Install fetch interceptor for OAuth metadata requests
  const interceptedFetch = createOAuthFetchInterceptor();
  window.fetch = interceptedFetch;

  try {
    const provider = new MCPOAuthProvider(options.serverName, options.clientId);

    // Store server URL for callback recovery
    localStorage.setItem(
      `mcp-serverUrl-${options.serverName}`,
      options.serverUrl,
    );
    localStorage.setItem("mcp-oauth-pending", options.serverName);

    // Store custom client ID if provided, so it can be retrieved during callback
    if (options.clientId) {
      const existingClientInfo = localStorage.getItem(
        `mcp-client-${options.serverName}`,
      );
      const existingJson = existingClientInfo
        ? JSON.parse(existingClientInfo)
        : {};

      localStorage.setItem(
        `mcp-client-${options.serverName}`,
        JSON.stringify({
          ...existingJson,
          client_id: options.clientId,
        }),
      );
    }

    const authArgs: any = { serverUrl: options.serverUrl };
    if (options.scopes && options.scopes.length > 0) {
      authArgs.scope = options.scopes.join(" ");
    }
    const result = await auth(provider, authArgs);

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
    let errorMessage = "Unknown OAuth error";

    if (error instanceof Error) {
      errorMessage = error.message;

      // Provide more helpful error messages for common client ID issues
      if (
        errorMessage.includes("invalid_client") ||
        errorMessage.includes("client_id")
      ) {
        errorMessage =
          "Invalid client ID. Please verify the client ID is correctly registered with the OAuth provider.";
      } else if (errorMessage.includes("unauthorized_client")) {
        errorMessage =
          "Client not authorized. The client ID may not be registered for this server or scope.";
      } else if (errorMessage.includes("invalid_request")) {
        errorMessage =
          "OAuth request invalid. Please check your client ID and try again.";
      }
    }

    return {
      success: false,
      error: errorMessage,
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
  authorizationCode: string,
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

    // Get stored client ID if any
    const storedClientInfo = localStorage.getItem(`mcp-client-${serverName}`);
    const customClientId = storedClientInfo
      ? JSON.parse(storedClientInfo).client_id
      : undefined;

    const provider = new MCPOAuthProvider(serverName, customClientId);

    const result = await auth(provider, {
      serverUrl,
      authorizationCode,
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
    let errorMessage = "Unknown callback error";

    if (error instanceof Error) {
      errorMessage = error.message;

      // Provide more helpful error messages for common client ID issues
      if (
        errorMessage.includes("invalid_client") ||
        errorMessage.includes("client_id")
      ) {
        errorMessage =
          "Invalid client ID during token exchange. Please verify the client ID is correctly registered.";
      } else if (errorMessage.includes("unauthorized_client")) {
        errorMessage =
          "Client not authorized for token exchange. The client ID may not match the one used for authorization.";
      } else if (errorMessage.includes("invalid_grant")) {
        errorMessage =
          "Authorization code invalid or expired. Please try the OAuth flow again.";
      }
    }

    return {
      success: false,
      error: errorMessage,
    };
  } finally {
    // Restore original fetch
    window.fetch = originalFetch;
  }
}

/**
 * Gets stored tokens for a server, including client_id from client information
 */
export function getStoredTokens(serverName: string): any {
  const tokens = localStorage.getItem(`mcp-tokens-${serverName}`);
  const clientInfo = localStorage.getItem(`mcp-client-${serverName}`);
  // TODO: Maybe we should move clientID away from the token info? Not sure if clientID is bonded to token
  if (!tokens) return undefined;

  const tokensJson = JSON.parse(tokens);
  const clientJson = clientInfo ? JSON.parse(clientInfo) : {};

  // Merge tokens with client_id from client information
  return {
    ...tokensJson,
    client_id: clientJson.client_id || tokensJson.client_id,
  };
}

/**
 * Waits for tokens to be available with timeout
 */
export async function waitForTokens(
  serverName: string,
  timeoutMs: number = 5000,
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
  serverName: string,
): Promise<OAuthResult> {
  // Install fetch interceptor for OAuth metadata requests
  const interceptedFetch = createOAuthFetchInterceptor();
  window.fetch = interceptedFetch;

  try {
    // Get stored client ID if any
    const storedClientInfo = localStorage.getItem(`mcp-client-${serverName}`);
    const customClientId = storedClientInfo
      ? JSON.parse(storedClientInfo).client_id
      : undefined;

    const provider = new MCPOAuthProvider(serverName, customClientId);
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

    const result = await auth(provider, { serverUrl });

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
    let errorMessage = "Unknown refresh error";

    if (error instanceof Error) {
      errorMessage = error.message;

      // Provide more helpful error messages for common client ID issues during refresh
      if (
        errorMessage.includes("invalid_client") ||
        errorMessage.includes("client_id")
      ) {
        errorMessage =
          "Invalid client ID during token refresh. The stored client ID may be incorrect.";
      } else if (errorMessage.includes("invalid_grant")) {
        errorMessage =
          "Refresh token invalid or expired. Please re-authenticate with the OAuth provider.";
      } else if (errorMessage.includes("unauthorized_client")) {
        errorMessage =
          "Client not authorized for token refresh. Please re-authenticate.";
      }
    }

    return {
      success: false,
      error: errorMessage,
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
  tokens: any,
): HttpServerDefinition {
  // Normalize the URL to avoid leaking query/hash (e.g., ?login) into MCP base URL
  const normalizedUrl = new URL(serverUrl);
  normalizedUrl.search = "";
  normalizedUrl.hash = "";

  return {
    url: normalizedUrl,
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
