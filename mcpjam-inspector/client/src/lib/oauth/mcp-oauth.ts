/**
 * Clean OAuth implementation using only the official MCP SDK with CORS proxy support
 */

import {
  auth,
  OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { HttpServerDefinition } from "@/shared/types.js";
import { generateRandomString } from "./state-machines/shared/helpers";
import { authFetch } from "@/lib/session-token";

// Store original fetch for restoration
const originalFetch = window.fetch;

type StoragePrefix =
  | "mcp-tokens"
  | "mcp-client"
  | "mcp-verifier"
  | "mcp-oauth-config"
  | "mcp-serverUrl";

const buildKey = (prefix: StoragePrefix, serverId: string) =>
  `${prefix}-${serverId}`;

function readWithMigration(
  prefix: StoragePrefix,
  serverId: string,
  serverName?: string,
): string | null {
  const primaryKey = buildKey(prefix, serverId);
  const existing = localStorage.getItem(primaryKey);
  if (existing !== null) return existing;
  if (!serverName) return null;
  const legacyKey = `${prefix}-${serverName}`;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy !== null) {
    localStorage.setItem(primaryKey, legacy);
    return legacy;
  }
  return null;
}

function writeWithLegacy(
  prefix: StoragePrefix,
  serverId: string,
  value: string,
  serverName?: string,
) {
  localStorage.setItem(buildKey(prefix, serverId), value);
  if (serverName && serverName !== serverId) {
    localStorage.setItem(`${prefix}-${serverName}`, value);
  }
}

function removeWithLegacy(
  prefix: StoragePrefix,
  serverId: string,
  serverName?: string,
) {
  localStorage.removeItem(buildKey(prefix, serverId));
  if (serverName) {
    localStorage.removeItem(`${prefix}-${serverName}`);
  }
}

/**
 * Custom fetch interceptor that proxies OAuth requests through our server to avoid CORS
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

    // Check if this is an OAuth-related request that needs CORS bypass
    const isOAuthRequest =
      url.includes("/.well-known/") ||
      url.match(/\/(register|token|authorize)$/);

    if (!isOAuthRequest) {
      return await originalFetch(input, init);
    }

    // Proxy OAuth requests through our server
    try {
      const isMetadata = url.includes("/.well-known/");
      const proxyUrl = isMetadata
        ? `/api/mcp/oauth/metadata?url=${encodeURIComponent(url)}`
        : `/api/mcp/oauth/proxy`;

      if (isMetadata) {
        return await authFetch(proxyUrl, { ...init, method: "GET" });
      }

      // For OAuth endpoints, serialize and proxy the full request
      const body = init?.body ? await serializeBody(init.body) : undefined;
      const response = await authFetch(proxyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          method: init?.method || "POST",
          headers: init?.headers
            ? Object.fromEntries(new Headers(init.headers as HeadersInit))
            : {},
          body,
        }),
      });

      // If the proxy call itself failed (e.g., auth error), return that response directly
      if (!response.ok) {
        return response;
      }

      const data = await response.json();
      return new Response(JSON.stringify(data.body), {
        status: data.status,
        statusText: data.statusText,
        headers: new Headers(data.headers),
      });
    } catch (error) {
      console.error("OAuth proxy failed, falling back to direct fetch:", error);
      return await originalFetch(input, init);
    }
  };
}

/**
 * Serialize request body for proxying
 */
async function serializeBody(body: BodyInit): Promise<any> {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams || body instanceof FormData) {
    return Object.fromEntries(body.entries());
  }
  if (body instanceof Blob) return await body.text();
  return body;
}

export interface MCPOAuthOptions {
  serverId: string;
  serverName: string;
  serverUrl: string;
  scopes?: string[];
  clientId?: string;
  clientSecret?: string;
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
  private serverId: string;
  private serverName: string;
  private redirectUri: string;
  private customClientId?: string;
  private customClientSecret?: string;

  constructor(
    serverId: string,
    serverName: string,
    customClientId?: string,
    customClientSecret?: string,
  ) {
    this.serverId = serverId;
    this.serverName = serverName;
    this.redirectUri = `${window.location.origin}/oauth/callback`;
    this.customClientId = customClientId;
    this.customClientSecret = customClientSecret;
  }

  state(): string {
    return generateRandomString(32);
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
    const stored = readWithMigration(
      "mcp-client",
      this.serverId,
      this.serverName,
    );
    const storedJson = stored ? JSON.parse(stored) : undefined;

    // If custom client ID is provided, use it
    if (this.customClientId) {
      if (storedJson) {
        // If there's stored information, merge with custom client credentials
        const result = {
          ...storedJson,
          client_id: this.customClientId,
        };
        // Add client secret if provided
        if (this.customClientSecret) {
          result.client_secret = this.customClientSecret;
        }
        return result;
      } else {
        // If no stored information, create a minimal client info with custom credentials
        const result: any = {
          client_id: this.customClientId,
        };
        if (this.customClientSecret) {
          result.client_secret = this.customClientSecret;
        }
        return result;
      }
    }
    return storedJson;
  }

  async saveClientInformation(clientInformation: any) {
    writeWithLegacy(
      "mcp-client",
      this.serverId,
      JSON.stringify(clientInformation),
      this.serverName,
    );
  }

  tokens() {
    const stored = readWithMigration(
      "mcp-tokens",
      this.serverId,
      this.serverName,
    );
    return stored ? JSON.parse(stored) : undefined;
  }

  async saveTokens(tokens: any) {
    writeWithLegacy(
      "mcp-tokens",
      this.serverId,
      JSON.stringify(tokens),
      this.serverName,
    );
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    // Store server name for callback recovery
    localStorage.setItem(
      "mcp-oauth-pending",
      JSON.stringify({ id: this.serverId, name: this.serverName }),
    );
    // Store current hash to restore after OAuth callback
    if (window.location.hash) {
      localStorage.setItem("mcp-oauth-return-hash", window.location.hash);
    }
    window.location.href = authorizationUrl.toString();
  }

  async saveCodeVerifier(codeVerifier: string) {
    writeWithLegacy(
      "mcp-verifier",
      this.serverId,
      codeVerifier,
      this.serverName,
    );
  }

  codeVerifier(): string {
    const verifier = readWithMigration(
      "mcp-verifier",
      this.serverId,
      this.serverName,
    );
    if (!verifier) {
      throw new Error("Code verifier not found");
    }
    return verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier") {
    switch (scope) {
      case "all":
        removeWithLegacy("mcp-tokens", this.serverId, this.serverName);
        removeWithLegacy("mcp-client", this.serverId, this.serverName);
        removeWithLegacy("mcp-verifier", this.serverId, this.serverName);
        break;
      case "client":
        removeWithLegacy("mcp-client", this.serverId, this.serverName);
        break;
      case "tokens":
        removeWithLegacy("mcp-tokens", this.serverId, this.serverName);
        break;
      case "verifier":
        removeWithLegacy("mcp-verifier", this.serverId, this.serverName);
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
    const provider = new MCPOAuthProvider(
      options.serverId,
      options.serverName,
      options.clientId,
      options.clientSecret,
    );

    // Store server URL for callback recovery
    writeWithLegacy(
      "mcp-serverUrl",
      options.serverId,
      options.serverUrl,
      options.serverName,
    );
    localStorage.setItem(
      "mcp-oauth-pending",
      JSON.stringify({ id: options.serverId, name: options.serverName }),
    );

    // Store OAuth configuration (scopes) for recovery if connection fails
    const oauthConfig: any = {};
    if (options.scopes && options.scopes.length > 0) {
      oauthConfig.scopes = options.scopes;
    }
    writeWithLegacy(
      "mcp-oauth-config",
      options.serverId,
      JSON.stringify(oauthConfig),
      options.serverName,
    );

    // Store custom client credentials if provided, so they can be retrieved during callback
    if (options.clientId || options.clientSecret) {
      const existingClientInfo = readWithMigration(
        "mcp-client",
        options.serverId,
        options.serverName,
      );
      const existingJson = existingClientInfo
        ? JSON.parse(existingClientInfo)
        : {};

      const updatedClientInfo: any = { ...existingJson };
      if (options.clientId) {
        updatedClientInfo.client_id = options.clientId;
      }
      if (options.clientSecret) {
        updatedClientInfo.client_secret = options.clientSecret;
      }

      writeWithLegacy(
        "mcp-client",
        options.serverId,
        JSON.stringify(updatedClientInfo),
        options.serverName,
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
): Promise<OAuthResult & { serverName?: string; serverId?: string }> {
  // Install fetch interceptor for OAuth metadata requests
  const interceptedFetch = createOAuthFetchInterceptor();
  window.fetch = interceptedFetch;

  try {
    // Get pending server metadata from localStorage
    const pending = localStorage.getItem("mcp-oauth-pending");
    let serverId: string | undefined;
    let serverName: string | undefined;
    if (pending) {
      try {
        const parsed = JSON.parse(pending);
        serverId = parsed?.id || parsed?.serverId || parsed?.name;
        serverName = parsed?.name || parsed?.serverName || parsed?.id;
      } catch {
        serverId = pending;
        serverName = pending;
      }
    }

    if (!serverId) {
      throw new Error("No pending OAuth flow found");
    }
    const displayName = serverName || serverId;

    // Get server URL
    const serverUrl = readWithMigration(
      "mcp-serverUrl",
      serverId,
      displayName,
    );
    if (!serverUrl) {
      throw new Error("Server URL not found for OAuth callback");
    }

    // Get stored client credentials if any
    const storedClientInfo = readWithMigration(
      "mcp-client",
      serverId,
      displayName,
    );
    const customClientId = storedClientInfo
      ? JSON.parse(storedClientInfo).client_id
      : undefined;
    const customClientSecret = storedClientInfo
      ? JSON.parse(storedClientInfo).client_secret
      : undefined;

    const provider = new MCPOAuthProvider(
      serverId,
      displayName,
      customClientId,
      customClientSecret,
    );

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
          serverName: displayName,
          serverId,
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
export function getStoredTokens(serverId: string, serverName?: string): any {
  const tokens = readWithMigration("mcp-tokens", serverId, serverName);
  const clientInfo = readWithMigration("mcp-client", serverId, serverName);
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
 * Checks if OAuth is configured for a server by looking at multiple sources
 */
export function hasOAuthConfig(serverId: string, serverName?: string): boolean {
  const storedServerUrl = readWithMigration(
    "mcp-serverUrl",
    serverId,
    serverName,
  );
  const storedClientInfo = readWithMigration(
    "mcp-client",
    serverId,
    serverName,
  );
  const storedOAuthConfig = readWithMigration(
    "mcp-oauth-config",
    serverId,
    serverName,
  );
  const storedTokens = getStoredTokens(serverId, serverName);

  return (
    storedServerUrl != null ||
    storedClientInfo != null ||
    storedOAuthConfig != null ||
    storedTokens != null
  );
}

/**
 * Waits for tokens to be available with timeout
 */
export async function waitForTokens(
  serverId: string,
  serverName?: string,
  timeoutMs: number = 5000,
): Promise<any> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const tokens = getStoredTokens(serverId, serverName);
    if (tokens?.access_token) {
      return tokens;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timeout waiting for tokens for server: ${serverId}`);
}

/**
 * Refreshes OAuth tokens for a server using the refresh token
 */
export async function refreshOAuthTokens(
  serverId: string,
  serverName?: string,
): Promise<OAuthResult> {
  // Install fetch interceptor for OAuth metadata requests
  const interceptedFetch = createOAuthFetchInterceptor();
  window.fetch = interceptedFetch;

  try {
    // Get stored client credentials if any
    const storedClientInfo = readWithMigration(
      "mcp-client",
      serverId,
      serverName,
    );
    const customClientId = storedClientInfo
      ? JSON.parse(storedClientInfo).client_id
      : undefined;
    const customClientSecret = storedClientInfo
      ? JSON.parse(storedClientInfo).client_secret
      : undefined;

    const provider = new MCPOAuthProvider(
      serverId,
      serverName || serverId,
      customClientId,
      customClientSecret,
    );
    const existingTokens = provider.tokens();

    if (!existingTokens?.refresh_token) {
      return {
        success: false,
        error: "No refresh token available",
      };
    }

    // Get server URL
    const serverUrl = readWithMigration(
      "mcp-serverUrl",
      serverId,
      serverName,
    );
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
export function clearOAuthData(
  serverId: string,
  serverName?: string,
): void {
  removeWithLegacy("mcp-tokens", serverId, serverName);
  removeWithLegacy("mcp-client", serverId, serverName);
  removeWithLegacy("mcp-verifier", serverId, serverName);
  removeWithLegacy("mcp-serverUrl", serverId, serverName);
  removeWithLegacy("mcp-oauth-config", serverId, serverName);
}

/**
 * Creates MCP server configuration with OAuth tokens
 */
function createServerConfig(
  serverUrl: string,
  tokens: any,
): HttpServerDefinition {
  // Preserve full URL including query and hash to support servers configured with query params
  const fullUrl = new URL(serverUrl);

  // Note: We don't include authProvider in the config because it can't be serialized
  // when sent to the backend via JSON. The backend will use the Authorization header instead.
  // Token refresh should be handled separately if the token expires.

  return {
    url: fullUrl,
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
