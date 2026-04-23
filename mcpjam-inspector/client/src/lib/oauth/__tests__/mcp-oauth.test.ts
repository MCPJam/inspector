/**
 * MCP OAuth Module Tests
 *
 * Tests for the OAuth fetch interceptor and persisted discovery state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDiscoverAuthorizationServerMetadata,
  mockDiscoverOAuthServerInfo,
  mockExchangeAuthorization,
  mockFetchToken,
  mockGetConvexSiteUrl,
  mockRegisterClient,
  mockSelectResourceURL,
  mockStartAuthorization,
} = vi.hoisted(() => ({
  mockDiscoverAuthorizationServerMetadata: vi.fn(),
  mockDiscoverOAuthServerInfo: vi.fn(),
  mockExchangeAuthorization: vi.fn(),
  mockFetchToken: vi.fn(),
  mockGetConvexSiteUrl: vi.fn(),
  mockRegisterClient: vi.fn(),
  mockSelectResourceURL: vi.fn(),
  mockStartAuthorization: vi.fn(),
}));

vi.mock("@mcpjam/sdk/browser", () => ({
  discoverAuthorizationServerMetadata: mockDiscoverAuthorizationServerMetadata,
  discoverOAuthServerInfo: mockDiscoverOAuthServerInfo,
  exchangeAuthorization: mockExchangeAuthorization,
  fetchToken: mockFetchToken,
  registerClient: mockRegisterClient,
  selectResourceURL: mockSelectResourceURL,
  startAuthorization: mockStartAuthorization,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

vi.mock("@/lib/convex-site-url", () => ({
  getConvexSiteUrl: mockGetConvexSiteUrl,
}));

vi.mock("../pkce", () => ({
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

function createLinearDiscoveryState(): any {
  return {
    authorizationServerUrl: "https://mcp.linear.app",
    resourceMetadataUrl:
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
    resourceMetadata: {
      resource: "https://mcp.linear.app/mcp",
      authorization_servers: ["https://mcp.linear.app"],
    },
    authorizationServerMetadata: {
      issuer: "https://mcp.linear.app",
      authorization_endpoint: "https://mcp.linear.app/authorize",
      token_endpoint: "https://mcp.linear.app/token",
      registration_endpoint: "https://mcp.linear.app/register",
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
    mockDiscoverAuthorizationServerMetadata.mockReset();
    mockDiscoverOAuthServerInfo.mockReset();
    mockExchangeAuthorization.mockReset();
    mockFetchToken.mockReset();
    mockGetConvexSiteUrl.mockReset();
    mockRegisterClient.mockReset();
    mockGetConvexSiteUrl.mockReturnValue("https://test.convex.site");
    mockSelectResourceURL.mockReset();
    mockStartAuthorization.mockReset();

    mockDiscoverOAuthServerInfo.mockResolvedValue(createDiscoveryState());
    mockDiscoverAuthorizationServerMetadata.mockResolvedValue(
      createDiscoveryState().authorizationServerMetadata,
    );
    mockRegisterClient.mockResolvedValue({
      client_id: "registered-client-id",
    });
    mockStartAuthorization.mockResolvedValue({
      authorizationUrl: new URL("https://auth.example.com/authorize"),
      codeVerifier: "test-verifier",
    });
    mockExchangeAuthorization.mockResolvedValue({
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
    });

    const sessionToken = await import("@/lib/session-token");
    authFetch = sessionToken.authFetch as ReturnType<typeof vi.fn>;
    authFetch.mockReset();
    mockSelectResourceURL.mockResolvedValue(undefined);

    const oauthModule = await import("../mcp-oauth");
    vi.spyOn(
      oauthModule.MCPOAuthProvider.prototype,
      "redirectToAuthorization",
    ).mockResolvedValue(undefined);
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
    useRegistryOAuthProxy?: boolean,
    serverName: string = "asana",
    serverUrl: string = "https://mcp.asana.com/v2/mcp",
  ) {
    mockDiscoverOAuthServerInfo.mockResolvedValueOnce(discoveryState);
    mockRegisterClient.mockResolvedValueOnce({
      client_id: `${serverName}-client-id`,
    });
    mockStartAuthorization.mockResolvedValueOnce({
      authorizationUrl: new URL(
        `${discoveryState.authorizationServerMetadata.authorization_endpoint}?state=mock-state`,
      ),
      codeVerifier: "test-verifier",
    });

    const { initiateOAuth } = await import("../mcp-oauth");
    const result = await initiateOAuth({
      serverName,
      serverUrl,
      registryServerId,
      useRegistryOAuthProxy,
    });

    expect(result.success).toBe(true);
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
      mockDiscoverOAuthServerInfo.mockImplementation(async (_serverUrl, options) => {
        const response = await options?.fetchFn?.(
          "https://example.com/.well-known/oauth-protected-resource/mcp",
        );
        if (!response) {
          throw new Error("Missing OAuth fetch function");
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return createDiscoveryState();
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
      mockDiscoverOAuthServerInfo.mockImplementation(async (_serverUrl, options) => {
        const response = await options?.fetchFn?.(
          "https://example.com/.well-known/oauth-protected-resource/mcp",
        );
        if (!response) {
          throw new Error("Missing OAuth fetch function");
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return createDiscoveryState();
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
      mockDiscoverOAuthServerInfo.mockImplementation(async (_serverUrl, options) => {
        const response = await options?.fetchFn?.(
          "https://example.com/.well-known/oauth-protected-resource/mcp",
        );
        if (!response) {
          throw new Error("Missing OAuth fetch function");
        }
        expect(response.ok).toBe(true);
        return createDiscoveryState();
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

    it("preserves JSON bodies for dynamic client registration requests", async () => {
      authFetch.mockResolvedValueOnce(
        createJsonResponse({
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
          body: {
            client_id: "linear-client-id",
            redirect_uris: [`${window.location.origin}/oauth/callback`],
          },
        }),
      );
      mockDiscoverOAuthServerInfo.mockResolvedValueOnce(createLinearDiscoveryState());
      mockRegisterClient.mockImplementationOnce(async (_authServerUrl, options) => {
        const registrationBody = JSON.stringify({
          client_name: "MCPJam - Linear",
          redirect_uris: [`${window.location.origin}/oauth/callback`],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });

        const response = await options.fetchFn!(
          "https://mcp.linear.app/register",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: registrationBody,
          },
        );
        expect(response.ok).toBe(true);
        return await response.json();
      });

      const { initiateOAuth } = await import("../mcp-oauth");
      const result = await initiateOAuth({
        serverName: "Linear",
        serverUrl: "https://mcp.linear.app/mcp",
        registryServerId: "registry-linear",
      });

      expect(result.success).toBe(true);
      expect(authFetch).toHaveBeenCalledWith(
        "/api/mcp/oauth/proxy",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://mcp.linear.app/register",
            method: "POST",
            headers: { "content-type": "application/json" },
            body: {
              client_name: "MCPJam - Linear",
              redirect_uris: [`${window.location.origin}/oauth/callback`],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            },
          }),
        }),
      );
    });
  });

  describe("persisted discovery state", () => {
    it("returns safe defaults when stored OAuth config is missing or malformed", async () => {
      const { readStoredOAuthConfig } = await import("../mcp-oauth");

      expect(readStoredOAuthConfig("missing")).toEqual({
        registryServerId: undefined,
        useRegistryOAuthProxy: false,
      });

      localStorage.setItem("mcp-oauth-config-bad", "{");
      expect(readStoredOAuthConfig("bad")).toEqual({
        registryServerId: undefined,
        useRegistryOAuthProxy: false,
      });
    });

    it("reads stored registry routing config", async () => {
      const { readStoredOAuthConfig } = await import("../mcp-oauth");

      localStorage.setItem(
        "mcp-oauth-config-linear",
        JSON.stringify({
          scopes: ["read", "write"],
          registryServerId: "registry-linear",
          useRegistryOAuthProxy: true,
        }),
      );

      expect(readStoredOAuthConfig("linear")).toEqual({
        scopes: ["read", "write"],
        registryServerId: "registry-linear",
        useRegistryOAuthProxy: true,
      });
    });

    it("detects OAuth token grant requests", async () => {
      const { isOAuthTokenGrantRequest } = await import("../mcp-oauth");

      expect(
        isOAuthTokenGrantRequest("POST", {
          grant_type: "authorization_code",
        }),
      ).toBe(true);
      expect(
        isOAuthTokenGrantRequest("POST", {
          grant_type: "refresh_token",
        }),
      ).toBe(true);
      expect(
        isOAuthTokenGrantRequest("POST", {
          client_name: "MCPJam - Linear",
        }),
      ).toBe(false);
      expect(
        isOAuthTokenGrantRequest("GET", {
          grant_type: "authorization_code",
        }),
      ).toBe(false);
    });

    it("only uses registry OAuth proxy for preregistered registry token exchanges", async () => {
      const { shouldUseRegistryOAuthProxy } = await import("../mcp-oauth");

      expect(
        shouldUseRegistryOAuthProxy({
          registryServerId: "registry-asana",
          useRegistryOAuthProxy: true,
          method: "POST",
          body: { grant_type: "authorization_code" },
        }),
      ).toBe(true);

      expect(
        shouldUseRegistryOAuthProxy({
          registryServerId: "registry-linear",
          useRegistryOAuthProxy: false,
          method: "POST",
          body: { grant_type: "authorization_code" },
        }),
      ).toBe(false);

      expect(
        shouldUseRegistryOAuthProxy({
          registryServerId: "registry-asana",
          useRegistryOAuthProxy: true,
          method: "POST",
          body: { client_name: "MCPJam - Asana" },
        }),
      ).toBe(false);
    });

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
      mockDiscoverOAuthServerInfo.mockResolvedValueOnce(discoveryState);
      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL("https://auth.example.com/authorize"),
        codeVerifier: "code-verifier",
      });
      mockExchangeAuthorization.mockImplementationOnce(async (_url, options) => {
        expect(options?.authorizationCode).toBe("oauth-code");
        expect(options?.codeVerifier).toBe("code-verifier");
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
      expect(initiateResult.success).toBe(true);

      const callbackResult = await handleOAuthCallback("oauth-code");

      expect(callbackResult.success).toBe(true);
      expect(callbackResult.serverName).toBe("asana");
      expect(callbackResult.serverConfig?.requestInit?.headers).toEqual({
        Authorization: "Bearer access-token",
      });
      expect(getStoredTokens("asana")?.access_token).toBe("access-token");
      expect(localStorage.getItem("mcp-discovery-asana")).not.toBeNull();
      expect(mockDiscoverOAuthServerInfo).toHaveBeenCalledTimes(1);
      expect(mockExchangeAuthorization).toHaveBeenCalledTimes(1);
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
      authFetch.mockImplementationOnce(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url.includes("/registry/oauth/token")) {
          return createJsonResponse({
            access_token: "access-token",
            refresh_token: "refresh-token",
            token_type: "Bearer",
          });
        }

        throw new Error(`Unexpected direct fetch to ${url}`);
      });

      const discoveryState = createAsanaDiscoveryState();
      await seedPendingOAuth("registry-asana", discoveryState, true);
      mockExchangeAuthorization.mockImplementationOnce(
        async (authServerUrl, options) => {
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
                code_verifier: options!.codeVerifier,
                redirect_uri: String(options!.redirectUri),
              }),
            },
          );
          return await response.json();
        },
      );

      const { handleOAuthCallback } = await import("../mcp-oauth");
      const callbackResult = await handleOAuthCallback("oauth-code");

      expect(callbackResult.success).toBe(true);
      expect(authFetch).toHaveBeenCalledTimes(1);
      expect(authFetch).toHaveBeenCalledWith(
        expect.stringMatching(/\.convex\.site\/registry\/oauth\/token$/),
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            registryServerId: "registry-asana",
            grant_type: "authorization_code",
            code: "oauth-code",
            code_verifier: "test-verifier",
            redirect_uri: `${window.location.origin}/oauth/callback`,
            grantType: "authorization_code",
            redirectUri: `${window.location.origin}/oauth/callback`,
            codeVerifier: "test-verifier",
          }),
        }),
      );
    });

    it("persists preregistered registry routing for fresh Asana OAuth connects", async () => {
      await seedPendingOAuth(
        "registry-asana",
        createAsanaDiscoveryState(),
        true,
      );

      expect(localStorage.getItem("mcp-oauth-config-asana")).toBe(
        JSON.stringify({
          registryServerId: "registry-asana",
          useRegistryOAuthProxy: true,
        }),
      );
    });

    it("routes Asana-style refresh token exchange through Convex for registry servers", async () => {
      authFetch.mockImplementationOnce(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url.includes("/registry/oauth/refresh")) {
          return createJsonResponse({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            token_type: "Bearer",
          });
        }

        throw new Error(`Unexpected direct fetch to ${url}`);
      });

      mockDiscoverOAuthServerInfo.mockResolvedValueOnce(createAsanaDiscoveryState());
      mockFetchToken.mockImplementationOnce(async (_provider, authServerUrl, options) => {
        expect(authServerUrl).toBe("https://app.asana.com");
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
        return await response.json();
      });

      localStorage.setItem(
        "mcp-serverUrl-asana",
        "https://mcp.asana.com/v2/mcp",
      );
      localStorage.setItem(
        "mcp-oauth-config-asana",
        JSON.stringify({
          registryServerId: "registry-asana",
          useRegistryOAuthProxy: true,
        }),
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
      expect(authFetch).toHaveBeenCalledTimes(1);
      expect(authFetch).toHaveBeenCalledWith(
        expect.stringMatching(/\.convex\.site\/registry\/oauth\/refresh$/),
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            registryServerId: "registry-asana",
            grant_type: "refresh_token",
            refresh_token: "stored-refresh-token",
            grantType: "refresh_token",
            refreshToken: "stored-refresh-token",
          }),
        }),
      );
    });

    it("re-registers the OAuth client after invalid_client refresh failures", async () => {
      localStorage.setItem(
        "mcp-serverUrl-asana",
        "https://mcp.asana.com/v2/mcp",
      );
      localStorage.setItem(
        "mcp-client-asana",
        JSON.stringify({
          client_id: "stale-client-id",
        }),
      );
      localStorage.setItem(
        "mcp-tokens-asana",
        JSON.stringify({
          access_token: "old-access-token",
          refresh_token: "stored-refresh-token",
          token_type: "Bearer",
        }),
      );

      mockDiscoverOAuthServerInfo.mockResolvedValueOnce(createAsanaDiscoveryState());
      mockFetchToken.mockRejectedValueOnce(
        Object.assign(new Error("Client authentication failed"), {
          code: "invalid_client",
        }),
      );
      mockRegisterClient.mockResolvedValueOnce({
        client_id: "new-client-id",
      });
      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL("https://app.asana.com/-/oauth_authorize"),
        codeVerifier: "fresh-verifier",
      });

      const [{ getOAuthTraceFailureStep }, { initiateOAuth }] =
        await Promise.all([
          import("../oauth-trace"),
          import("../mcp-oauth"),
        ]);

      const result = await initiateOAuth({
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/v2/mcp",
      });

      expect(result.success).toBe(true);
      expect(localStorage.getItem("mcp-client-asana")).toBe(
        JSON.stringify({
          client_id: "new-client-id",
        }),
      );
      expect(getOAuthTraceFailureStep(result.oauthTrace)).toBeUndefined();
    });

    it("preserves the original callback error and verifier when registry token exchange fails", async () => {
      authFetch.mockImplementationOnce(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

        if (url.includes("/registry/oauth/token")) {
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

      await seedPendingOAuth("registry-asana", undefined, true);
      mockExchangeAuthorization.mockImplementationOnce(
        async (_authServerUrl, options) => {
          const response = await options!.fetchFn!(
            "https://app.asana.com/-/oauth_token",
            {
              method: "POST",
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code: options!.authorizationCode!,
                code_verifier: options!.codeVerifier,
                redirect_uri: String(options!.redirectUri),
              }),
            },
          );
          if (!response.ok) {
            const payload = await response.json();
            throw new Error(`${payload.error}: ${payload.error_description}`);
          }
          return await response.json();
        },
      );

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
      mockExchangeAuthorization.mockImplementationOnce(
        async (_authServerUrl, options) => {
          const response = await options!.fetchFn!(
            "https://app.asana.com/-/oauth_token",
            {
              method: "POST",
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code: options!.authorizationCode!,
                code_verifier: options!.codeVerifier,
                redirect_uri: String(options!.redirectUri),
              }),
            },
          );
          return await response.json();
        },
      );

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

    it("uses the generic Inspector OAuth proxy for Asana when stored config is missing the preregistered flag", async () => {
      const browserFetch = vi.fn();
      vi.stubGlobal("fetch", browserFetch);
      await seedPendingOAuth(
        "registry-asana",
        createAsanaDiscoveryState(),
        false,
        "asana",
        "https://mcp.asana.com/v2/mcp",
      );
      authFetch.mockResolvedValueOnce(
        createJsonResponse({
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
          body: {
            access_token: "asana-access-token",
            refresh_token: "asana-refresh-token",
            token_type: "Bearer",
          },
        }),
      );
      mockExchangeAuthorization.mockImplementationOnce(
        async (_authServerUrl, options) => {
          const response = await options!.fetchFn!(
            "https://app.asana.com/-/oauth_token",
            {
              method: "POST",
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code: options!.authorizationCode!,
                code_verifier: options!.codeVerifier,
                redirect_uri: String(options!.redirectUri),
              }),
            },
          );
          return await response.json();
        },
      );

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
      expect(authFetch).not.toHaveBeenCalledWith(
        expect.stringMatching(/\.convex\.site\/registry\/oauth\/token$/),
        expect.anything(),
      );
    });

    it("uses the generic Inspector OAuth proxy for Linear-style registry callback token exchange", async () => {
      const browserFetch = vi.fn();
      vi.stubGlobal("fetch", browserFetch);
      await seedPendingOAuth(
        "registry-linear",
        createLinearDiscoveryState(),
        false,
        "linear",
        "https://mcp.linear.app/mcp",
      );
      authFetch.mockResolvedValueOnce(
        createJsonResponse({
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
          body: {
            access_token: "linear-access-token",
            refresh_token: "linear-refresh-token",
            token_type: "Bearer",
          },
        }),
      );
      mockExchangeAuthorization.mockImplementationOnce(
        async (_authServerUrl, options) => {
          const response = await options!.fetchFn!(
            "https://mcp.linear.app/token",
            {
              method: "POST",
              body: new URLSearchParams({
                grant_type: "authorization_code",
                code: options!.authorizationCode!,
                code_verifier: options!.codeVerifier,
                redirect_uri: String(options!.redirectUri),
              }),
            },
          );
          return await response.json();
        },
      );

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
            url: "https://mcp.linear.app/token",
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
      expect(authFetch).not.toHaveBeenCalledWith(
        expect.stringMatching(/\.convex\.site\/registry\/oauth\/token$/),
        expect.anything(),
      );
    });

    it("uses the generic Inspector OAuth proxy for Linear-style registry refresh token exchange", async () => {
      authFetch.mockResolvedValueOnce(
        createJsonResponse({
          status: 200,
          statusText: "OK",
          headers: { "Content-Type": "application/json" },
          body: {
            access_token: "new-linear-access-token",
            refresh_token: "new-linear-refresh-token",
            token_type: "Bearer",
          },
        }),
      );

      mockDiscoverOAuthServerInfo.mockResolvedValueOnce(createLinearDiscoveryState());
      mockFetchToken.mockImplementationOnce(async (_provider, _authServerUrl, options) => {
        const response = await options.fetchFn!(
          "https://mcp.linear.app/token",
          {
            method: "POST",
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: "stored-refresh-token",
            }),
          },
        );
        return await response.json();
      });

      localStorage.setItem(
        "mcp-serverUrl-linear",
        "https://mcp.linear.app/mcp",
      );
      localStorage.setItem(
        "mcp-oauth-config-linear",
        JSON.stringify({ registryServerId: "registry-linear" }),
      );
      localStorage.setItem(
        "mcp-tokens-linear",
        JSON.stringify({
          access_token: "old-linear-access-token",
          refresh_token: "stored-refresh-token",
          token_type: "Bearer",
        }),
      );

      const { refreshOAuthTokens } = await import("../mcp-oauth");
      const refreshResult = await refreshOAuthTokens("linear");

      expect(refreshResult.success).toBe(true);
      expect(authFetch).toHaveBeenCalledWith(
        "/api/mcp/oauth/proxy",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: "https://mcp.linear.app/token",
            method: "POST",
            headers: {},
            body: {
              grant_type: "refresh_token",
              refresh_token: "stored-refresh-token",
            },
          }),
        }),
      );
      expect(authFetch).not.toHaveBeenCalledWith(
        expect.stringMatching(/\.convex\.site\/registry\/oauth\/refresh$/),
        expect.anything(),
      );
    });
  });
});
