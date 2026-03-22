/**
 * MCP OAuth Module Tests
 *
 * Tests for the OAuth fetch interceptor and persisted discovery state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDiscoverAuthorizationServerMetadata,
  mockDiscoverOAuthServerInfo,
  mockFetchToken,
  mockSdkAuth,
  mockSelectResourceURL,
} = vi.hoisted(() => ({
  mockDiscoverAuthorizationServerMetadata: vi.fn(),
  mockDiscoverOAuthServerInfo: vi.fn(),
  mockFetchToken: vi.fn(),
  mockSdkAuth: vi.fn(),
  mockSelectResourceURL: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  auth: mockSdkAuth,
  discoverAuthorizationServerMetadata: mockDiscoverAuthorizationServerMetadata,
  discoverOAuthServerInfo: mockDiscoverOAuthServerInfo,
  fetchToken: mockFetchToken,
  selectResourceURL: mockSelectResourceURL,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

vi.mock("../state-machines/shared/helpers", () => ({
  generateRandomString: vi.fn(() => "mock-random-string"),
}));

function createDiscoveryState(): any {
  return {
    authorizationServerUrl: "https://auth.example.com",
    resourceMetadataUrl:
      "https://example.com/.well-known/oauth-protected-resource",
    resourceMetadata: {
      resource: "https://example.com",
      authorization_servers: ["https://auth.example.com"],
    },
    authorizationServerMetadata: {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
    },
  };
}

function createAsanaDiscoveryState(): any {
  return {
    authorizationServerUrl: "https://app.asana.com",
    resourceMetadataUrl:
      "https://mcp.asana.com/.well-known/oauth-protected-resource/v2/mcp",
    resourceMetadata: {
      resource: "https://mcp.asana.com/v2/mcp",
      authorization_servers: ["https://app.asana.com"],
    },
    authorizationServerMetadata: {
      issuer: "https://app.asana.com",
      authorization_endpoint: "https://app.asana.com/-/oauth_authorize",
      token_endpoint: "https://app.asana.com/-/oauth_token",
      registration_endpoint: "https://app.asana.com/-/oauth_register",
    },
  };
}

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("mcp-oauth", () => {
  let authFetch: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    mockSdkAuth.mockReset();
    mockDiscoverAuthorizationServerMetadata.mockReset();
    mockDiscoverOAuthServerInfo.mockReset();
    mockFetchToken.mockReset();
    mockSelectResourceURL.mockReset();

    const sessionToken = await import("@/lib/session-token");
    authFetch = sessionToken.authFetch as ReturnType<typeof vi.fn>;
    authFetch.mockReset();
    mockSelectResourceURL.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
  });

  async function seedPendingOAuth(
    registryServerId?: string,
    discoveryState: any = createAsanaDiscoveryState(),
  ) {
    mockSdkAuth.mockImplementationOnce(async (provider) => {
      await provider.saveDiscoveryState?.(discoveryState);
      await provider.saveCodeVerifier("test-verifier");
      return "REDIRECT";
    });

    const { initiateOAuth } = await import("../mcp-oauth");
    const result = await initiateOAuth({
      serverName: "asana",
      serverUrl: "https://mcp.asana.com/v2/mcp",
      registryServerId,
    });

    expect(result).toEqual({ success: true });
    return discoveryState;
  }

  describe("proxy endpoint auth failures", () => {
    it("returns 401 response directly when auth fails on proxy endpoint", async () => {
      const authErrorResponse = new Response(
        JSON.stringify({
          error: "Unauthorized",
          message: "Session token required.",
          hint: "Include X-MCP-Session-Auth: Bearer <token> header",
        }),
        {
          status: 401,
          statusText: "Unauthorized",
          headers: { "Content-Type": "application/json" },
        },
      );
      authFetch.mockResolvedValue(authErrorResponse);
      mockSdkAuth.mockImplementation(async () => {
        const response = await window.fetch(
          "https://example.com/.well-known/oauth-protected-resource/mcp",
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return "AUTHORIZED";
      });

      const { initiateOAuth } = await import("../mcp-oauth");
      const result = await initiateOAuth({
        serverName: "test-server",
        serverUrl: "https://example.com/mcp",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("does not mask 401 as 200 with empty body", async () => {
      const authErrorResponse = new Response(
        JSON.stringify({
          error: "Unauthorized",
          message: "Session token required.",
        }),
        {
          status: 401,
          statusText: "Unauthorized",
        },
      );
      authFetch.mockResolvedValue(authErrorResponse);
      mockSdkAuth.mockImplementation(async () => {
        const response = await window.fetch(
          "https://example.com/.well-known/oauth-protected-resource/mcp",
        );
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return "AUTHORIZED";
      });

      const { initiateOAuth } = await import("../mcp-oauth");
      const result = await initiateOAuth({
        serverName: "test-server",
        serverUrl: "https://example.com/mcp",
      });

      expect(result.success).toBe(false);
    });

    it("propagates successful proxy responses correctly", async () => {
      const metadataResponse = new Response(
        JSON.stringify({
          authorization_servers: ["https://auth.example.com"],
        }),
        { status: 200 },
      );
      authFetch.mockResolvedValue(metadataResponse);
      mockSdkAuth.mockImplementation(async () => {
        const response = await window.fetch(
          "https://example.com/.well-known/oauth-protected-resource/mcp",
        );
        expect(response.ok).toBe(true);
        return "REDIRECT";
      });

      const { initiateOAuth } = await import("../mcp-oauth");
      const result = await initiateOAuth({
        serverName: "test-server",
        serverUrl: "https://example.com/mcp",
      });

      expect(result.success).toBe(true);
      expect(authFetch).toHaveBeenCalledWith(
        expect.stringMatching(
          /\/api\/mcp\/oauth\/metadata\?url=.*oauth-protected-resource/,
        ),
        expect.objectContaining({ method: "GET" }),
      );
    });
  });

  describe("persisted discovery state", () => {
    it("round-trips discovery state for the matching server URL", async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const discoveryState = createDiscoveryState();
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
      );

      await provider.saveDiscoveryState(discoveryState);

      expect(provider.discoveryState()).toEqual(discoveryState);
    });

    it("ignores stale discovery state when the server URL changes", async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const discoveryState = createDiscoveryState();
      const originalProvider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
      );
      await originalProvider.saveDiscoveryState(discoveryState);

      const nextProvider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/alt-sse",
      );

      expect(nextProvider.discoveryState()).toBeUndefined();
    });

    it('clears discovery state on invalidateCredentials("all")', async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
      );
      await provider.saveDiscoveryState(createDiscoveryState());

      await provider.invalidateCredentials("all");

      expect(localStorage.getItem("mcp-discovery-asana")).toBeNull();
      expect(provider.discoveryState()).toBeUndefined();
    });

    it('clears discovery state on invalidateCredentials("discovery")', async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
      );
      await provider.saveDiscoveryState(createDiscoveryState());

      await provider.invalidateCredentials("discovery");

      expect(localStorage.getItem("mcp-discovery-asana")).toBeNull();
      expect(provider.discoveryState()).toBeUndefined();
    });

    it("clears discovery state in clearOAuthData", async () => {
      const { MCPOAuthProvider, clearOAuthData } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
      );
      await provider.saveDiscoveryState(createDiscoveryState());

      clearOAuthData("asana");

      expect(localStorage.getItem("mcp-discovery-asana")).toBeNull();
      expect(provider.discoveryState()).toBeUndefined();
    });

    it("reuses cached discovery state after the callback reload", async () => {
      const discoveryState = createDiscoveryState();
      mockSdkAuth.mockImplementationOnce(async (provider) => {
        await provider.saveDiscoveryState?.(discoveryState);
        await provider.saveCodeVerifier("code-verifier");
        return "REDIRECT";
      });
      mockFetchToken.mockImplementationOnce(async (provider, _url, options) => {
        expect(options?.authorizationCode).toBe("oauth-code");
        expect(provider.discoveryState?.()).toEqual(discoveryState);
        expect(provider.codeVerifier()).toBe("code-verifier");
        return {
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
        };
      });

      const { getStoredTokens, handleOAuthCallback, initiateOAuth } =
        await import("../mcp-oauth");

      const initiateResult = await initiateOAuth({
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/sse",
      });
      expect(initiateResult).toEqual({ success: true });

      const callbackResult = await handleOAuthCallback("oauth-code");

      expect(callbackResult.success).toBe(true);
      expect(callbackResult.serverName).toBe("asana");
      expect(callbackResult.serverConfig?.requestInit?.headers).toEqual({
        Authorization: "Bearer access-token",
      });
      expect(getStoredTokens("asana")?.access_token).toBe("access-token");
      expect(localStorage.getItem("mcp-discovery-asana")).not.toBeNull();
      expect(mockSdkAuth).toHaveBeenCalledTimes(1);
      expect(mockFetchToken).toHaveBeenCalledTimes(1);
    });

    it("treats malformed stored token data as invalid instead of throwing", async () => {
      const { getStoredTokens, getStoredTokensState } =
        await import("../mcp-oauth");

      localStorage.setItem("mcp-tokens-asana", '{"access_token":"broken"');
      localStorage.setItem("mcp-client-asana", '{"client_id":"broken"');

      expect(getStoredTokens("asana")).toBeUndefined();
      expect(getStoredTokensState("asana")).toEqual({
        tokens: undefined,
        isInvalid: true,
      });
    });

    it("routes Asana-style callback token exchange through Convex for registry servers", async () => {
      vi.stubEnv("VITE_CONVEX_SITE_URL", "https://example.convex.site");
      const browserFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "https://example.convex.site/registry/oauth/token") {
          return createJsonResponse({
            access_token: "access-token",
            refresh_token: "refresh-token",
            token_type: "Bearer",
          });
        }

        throw new Error(`Unexpected direct fetch to ${url}`);
      });
      vi.stubGlobal("fetch", browserFetch);

      const discoveryState = createAsanaDiscoveryState();
      await seedPendingOAuth("registry-asana", discoveryState);
      mockFetchToken.mockImplementationOnce(async (provider, authServerUrl, options) => {
        expect(authServerUrl).toBe("https://app.asana.com");
        expect(options?.metadata?.token_endpoint).toBe(
          "https://app.asana.com/-/oauth_token",
        );
        const response = await options!.fetchFn!(
          "https://app.asana.com/-/oauth_token",
          {
            method: "POST",
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: options!.authorizationCode!,
              code_verifier: provider.codeVerifier(),
              redirect_uri: String(provider.redirectUrl),
            }),
          },
        );
        return await response.json();
      });

      const { handleOAuthCallback } = await import("../mcp-oauth");
      const callbackResult = await handleOAuthCallback("oauth-code");

      expect(callbackResult.success).toBe(true);
      expect(browserFetch).toHaveBeenCalledTimes(1);
      expect(browserFetch).toHaveBeenCalledWith(
        "https://example.convex.site/registry/oauth/token",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            registryServerId: "registry-asana",
            grant_type: "authorization_code",
            grantType: "authorization_code",
            code: "oauth-code",
            code_verifier: "test-verifier",
            codeVerifier: "test-verifier",
            redirect_uri: `${window.location.origin}/oauth/callback`,
            redirectUri: `${window.location.origin}/oauth/callback`,
          }),
        }),
      );
    });

    it("routes Asana-style refresh token exchange through Convex for registry servers", async () => {
      vi.stubEnv("VITE_CONVEX_SITE_URL", "https://example.convex.site");
      const browserFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "https://example.convex.site/registry/oauth/refresh") {
          return createJsonResponse({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            token_type: "Bearer",
          });
        }

        throw new Error(`Unexpected direct fetch to ${url}`);
      });
      vi.stubGlobal("fetch", browserFetch);

      mockSdkAuth.mockImplementationOnce(async (_provider, options) => {
        const response = await options.fetchFn!(
          "https://app.asana.com/-/oauth_token",
          {
            method: "POST",
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: "stored-refresh-token",
            }),
          },
        );
        const tokens = await response.json();
        await _provider.saveTokens(tokens);
        return "AUTHORIZED";
      });

      localStorage.setItem("mcp-serverUrl-asana", "https://mcp.asana.com/v2/mcp");
      localStorage.setItem(
        "mcp-oauth-config-asana",
        JSON.stringify({ registryServerId: "registry-asana" }),
      );
      localStorage.setItem(
        "mcp-tokens-asana",
        JSON.stringify({
          access_token: "old-access-token",
          refresh_token: "stored-refresh-token",
          token_type: "Bearer",
        }),
      );

      const { refreshOAuthTokens } = await import("../mcp-oauth");
      const refreshResult = await refreshOAuthTokens("asana");

      expect(refreshResult.success).toBe(true);
      expect(browserFetch).toHaveBeenCalledTimes(1);
      expect(browserFetch).toHaveBeenCalledWith(
        "https://example.convex.site/registry/oauth/refresh",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            registryServerId: "registry-asana",
            grant_type: "refresh_token",
            grantType: "refresh_token",
            refresh_token: "stored-refresh-token",
            refreshToken: "stored-refresh-token",
          }),
        }),
      );
    });

    it("preserves the original callback error and verifier when registry token exchange fails", async () => {
      vi.stubEnv("VITE_CONVEX_SITE_URL", "https://example.convex.site");
      const browserFetch = vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url === "https://example.convex.site/registry/oauth/token") {
          return createJsonResponse(
            {
              error: "invalid_client",
              error_description: "Client authentication failed",
            },
            401,
          );
        }

        throw new Error(`Unexpected direct fetch to ${url}`);
      });
      vi.stubGlobal("fetch", browserFetch);

      await seedPendingOAuth("registry-asana");
      mockFetchToken.mockImplementationOnce(async (provider, _authServerUrl, options) => {
        const response = await options!.fetchFn!(
          "https://app.asana.com/-/oauth_token",
          {
            method: "POST",
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: options!.authorizationCode!,
              code_verifier: provider.codeVerifier(),
              redirect_uri: String(provider.redirectUrl),
            }),
          },
        );
        if (!response.ok) {
          const payload = await response.json();
          throw new Error(`${payload.error}: ${payload.error_description}`);
        }
        return await response.json();
      });

      const { handleOAuthCallback } = await import("../mcp-oauth");
      const callbackResult = await handleOAuthCallback("oauth-code");

      expect(callbackResult.success).toBe(false);
      expect(callbackResult.error).not.toBe("Code verifier not found");
      expect(callbackResult.error).toContain(
        "Invalid client ID during token exchange",
      );
      expect(localStorage.getItem("mcp-verifier-asana")).toBe("test-verifier");
    });

    it("uses the generic Inspector OAuth proxy for non-registry token exchange", async () => {
      const browserFetch = vi.fn();
      vi.stubGlobal("fetch", browserFetch);
      await seedPendingOAuth(undefined);
      authFetch.mockResolvedValueOnce(
        createJsonResponse({
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
          body: {
            access_token: "proxied-access-token",
            refresh_token: "proxied-refresh-token",
            token_type: "Bearer",
          },
        }),
      );
      mockFetchToken.mockImplementationOnce(async (provider, _authServerUrl, options) => {
        const response = await options!.fetchFn!(
          "https://app.asana.com/-/oauth_token",
          {
            method: "POST",
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code: options!.authorizationCode!,
              code_verifier: provider.codeVerifier(),
              redirect_uri: String(provider.redirectUrl),
            }),
          },
        );
        return await response.json();
      });

      const { handleOAuthCallback } = await import("../mcp-oauth");
      const callbackResult = await handleOAuthCallback("oauth-code");

      expect(callbackResult.success).toBe(true);
      expect(browserFetch).not.toHaveBeenCalled();
      expect(authFetch).toHaveBeenCalledWith(
        "/api/mcp/oauth/proxy",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://app.asana.com/-/oauth_token",
            method: "POST",
            headers: {},
            body: {
              grant_type: "authorization_code",
              code: "oauth-code",
              code_verifier: "test-verifier",
              redirect_uri: `${window.location.origin}/oauth/callback`,
            },
          }),
        }),
      );
    });
  });
});
