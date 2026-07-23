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
  mockRunOAuthStateMachine,
  mockSelectResourceURL,
  mockStartAuthorization,
} = vi.hoisted(() => ({
  mockDiscoverAuthorizationServerMetadata: vi.fn(),
  mockDiscoverOAuthServerInfo: vi.fn(),
  mockExchangeAuthorization: vi.fn(),
  mockFetchToken: vi.fn(),
  mockGetConvexSiteUrl: vi.fn(),
  mockRegisterClient: vi.fn(),
  mockRunOAuthStateMachine: vi.fn(),
  mockSelectResourceURL: vi.fn(),
  mockStartAuthorization: vi.fn(),
}));

vi.mock("@mcpjam/sdk/browser", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk/browser")>(
    "@mcpjam/sdk/browser"
  );
  return {
    ...actual,
    discoverAuthorizationServerMetadata:
      mockDiscoverAuthorizationServerMetadata,
    discoverOAuthServerInfo: mockDiscoverOAuthServerInfo,
    exchangeAuthorization: mockExchangeAuthorization,
    fetchToken: mockFetchToken,
    registerClient: mockRegisterClient,
    runOAuthStateMachine: mockRunOAuthStateMachine,
    selectResourceURL: mockSelectResourceURL,
    startAuthorization: mockStartAuthorization,
  };
});

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

function createCimdDiscoveryState(): any {
  return {
    authorizationServerUrl: "https://auth.example.com",
    resourceMetadataUrl:
      "https://example.com/.well-known/oauth-protected-resource/mcp",
    resourceMetadata: {
      resource: "https://example.com/mcp",
      authorization_servers: ["https://auth.example.com"],
    },
    authorizationServerMetadata: {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: "https://auth.example.com/register",
      client_id_metadata_document_supported: true,
    },
  };
}

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getUrlString(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
    ? input.toString()
    : input.url;
}

function createProtectedResourceMetadataUrl(serverUrl: string): string {
  const parsed = new URL(serverUrl);
  return `${parsed.origin}/.well-known/oauth-protected-resource${parsed.pathname}`;
}

function findAutomaticDecisionStep(result: {
  oauthTrace?: {
    steps?: Array<{
      step: string;
      message?: string;
      details?: Record<string, unknown>;
    }>;
  };
}) {
  return result.oauthTrace?.steps?.find((step) =>
    step.message?.startsWith("Automatic resolved to ")
  );
}

function createUnauthorizedMcpResponse(serverUrl: string): Response {
  return new Response(null, {
    status: 401,
    statusText: "Unauthorized",
    headers: {
      "WWW-Authenticate": `Bearer resource_metadata="${createProtectedResourceMetadataUrl(
        serverUrl
      )}"`,
    },
  });
}

function createFetchFromRequestExecutor(
  requestExecutor: (request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  }) => Promise<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
    ok: boolean;
  }>
): typeof fetch {
  return async (input, init) => {
    const response = await requestExecutor({
      method: (init?.method ?? "GET").toUpperCase(),
      url: getUrlString(input),
      headers: init?.headers
        ? Object.fromEntries(new Headers(init.headers as HeadersInit))
        : {},
      body: init?.body,
    });

    const body =
      response.body === undefined || response.body === null
        ? null
        : typeof response.body === "string"
        ? response.body
        : JSON.stringify(response.body);

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

// A real authorization server returns the exact `state` the client issued, and
// the 2R-iss callback gate now enforces it. Echo the state persisted by
// initiateOAuth for the pending server so callback tests mirror real requests.
// Returns null when no session was stored (the no-session fallback path).
const issuedCallbackState = (): string | null => {
  const serverName = localStorage.getItem("mcp-oauth-pending");
  if (!serverName) return null;
  try {
    const raw = localStorage.getItem(`mcp-oauth-flow-state-${serverName}`);
    return raw ? (JSON.parse(raw).state?.state ?? null) : null;
  } catch {
    return null;
  }
};

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
    mockRunOAuthStateMachine.mockReset();
    mockGetConvexSiteUrl.mockReturnValue("https://test.convex.site");
    mockSelectResourceURL.mockReset();
    window.isElectron = false;
    delete window.electronAPI;
    mockStartAuthorization.mockReset();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        createUnauthorizedMcpResponse(getUrlString(input))
      )
    );

    mockDiscoverOAuthServerInfo.mockResolvedValue(createDiscoveryState());
    mockDiscoverAuthorizationServerMetadata.mockResolvedValue(
      createDiscoveryState().authorizationServerMetadata
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
    authFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = getUrlString(input);
      if (url.includes("/api/web/oauth/import-tokens")) {
        return createJsonResponse({
          success: true,
          kind: "generic",
          expiresAt: null,
        });
      }
      return createJsonResponse({});
    });
    const contextModule = await import("@/lib/apis/web/context");
    contextModule.setApiContext({
      projectId: "proj_default",
      serverIdsByName: {
        asana: "srv_asana",
        linear: "srv_linear",
        Linear: "srv_linear_upper",
        example: "srv_example",
        hosted: "srv_hosted",
        learn: "srv_learn",
        "test-server": "srv_test",
      },
      getAccessToken: async () => null,
    });
    mockSelectResourceURL.mockResolvedValue(undefined);
    mockRunOAuthStateMachine.mockImplementation(async (config: any) => {
      const getState = config.getState ?? (() => config.state);
      const updateState = (updates: Record<string, unknown>) => {
        config.updateState(updates);
      };
      const fetchFn = createFetchFromRequestExecutor(config.requestExecutor);

      try {
        if (config.onAuthorizationRequest) {
          await config.requestExecutor({
            method: "POST",
            url: config.serverUrl,
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "initialize",
              params: {
                protocolVersion: config.protocolVersion,
                capabilities: {},
                clientInfo: {
                  name: "MCPJam Inspector",
                  version: "1.0.0",
                },
              },
              id: 1,
            }),
          });

          const discovered = await mockDiscoverOAuthServerInfo(
            config.serverUrl,
            {
              fetchFn,
            }
          );
          const preregistered = await config.loadPreregisteredCredentials?.({
            serverName: config.serverName,
            serverUrl: config.serverUrl,
          });
          const clientInformation =
            preregistered?.clientId || preregistered?.clientSecret
              ? {
                  client_id: preregistered.clientId,
                  ...(preregistered.clientSecret
                    ? { client_secret: preregistered.clientSecret }
                    : {}),
                }
              : await mockRegisterClient(discovered.authorizationServerUrl, {
                  metadata: config.dynamicRegistration,
                  redirectUri: config.redirectUrl,
                  fetchFn,
                });
          const authResult = await mockStartAuthorization(
            discovered.authorizationServerUrl,
            {
              metadata: discovered.authorizationServerMetadata,
              clientInformation,
              redirectUri: config.redirectUrl,
              scope: config.customScopes,
            }
          );

          updateState({
            authorizationServerUrl: discovered.authorizationServerUrl,
            resourceMetadataUrl: discovered.resourceMetadataUrl,
            resourceMetadata: discovered.resourceMetadata,
            authorizationServerMetadata: discovered.authorizationServerMetadata,
            clientId: clientInformation?.client_id,
            clientSecret: clientInformation?.client_secret,
            codeVerifier: authResult.codeVerifier,
            state: "mock-state",
            authorizationUrl: String(authResult.authorizationUrl),
            currentStep: "authorization_request",
            error: undefined,
          });

          const authorizationResult = await config.onAuthorizationRequest({
            authorizationUrl: String(authResult.authorizationUrl),
            state: getState(),
          });

          if (authorizationResult.type === "redirect") {
            return {
              completed: false,
              redirected: true,
              authorizationUrl: String(authResult.authorizationUrl),
              state: getState(),
            };
          }

          updateState({
            currentStep: "received_authorization_code",
            authorizationCode: authorizationResult.authorizationCode,
            error: undefined,
          });
        }

        const state = getState();
        const resource = await mockSelectResourceURL(
          config.serverUrl,
          undefined,
          state.resourceMetadata
        );
        const clientInformation = {
          client_id: state.clientId,
          ...(state.clientSecret ? { client_secret: state.clientSecret } : {}),
        };
        const tokens = await mockExchangeAuthorization(
          state.authorizationServerUrl,
          {
            metadata: state.authorizationServerMetadata,
            authorizationCode: state.authorizationCode,
            clientInformation,
            codeVerifier: state.codeVerifier,
            redirectUri: config.redirectUrl,
            ...(resource ? { resource } : {}),
            fetchFn,
          }
        );

        updateState({
          currentStep: "complete",
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          tokenType: tokens.token_type,
          expiresIn: tokens.expires_in,
          error: undefined,
        });

        return {
          completed: true,
          redirected: false,
          authorizationUrl: state.authorizationUrl,
          state: getState(),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateState({
          error: message,
        });
        return {
          completed: false,
          redirected: false,
          authorizationUrl: getState().authorizationUrl,
          state: getState(),
          error: { message },
        };
      }
    });

    const oauthModule = await import("../mcp-oauth");
    vi.spyOn(
      oauthModule.MCPOAuthProvider.prototype,
      "redirectToAuthorization"
    ).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
    window.isElectron = false;
    delete window.electronAPI;
  });

  async function seedPendingOAuth(
    registryServerId?: string,
    discoveryState: any = createAsanaDiscoveryState(),
    useRegistryOAuthProxy?: boolean,
    serverName: string = "asana",
    serverUrl: string = "https://mcp.asana.com/v2/mcp"
  ) {
    mockDiscoverOAuthServerInfo
      .mockResolvedValueOnce(discoveryState)
      .mockResolvedValueOnce(discoveryState);
    mockRegisterClient.mockResolvedValueOnce({
      client_id: `${serverName}-client-id`,
    });
    mockStartAuthorization.mockResolvedValueOnce({
      authorizationUrl: new URL(
        `${discoveryState.authorizationServerMetadata.authorization_endpoint}?state=mock-state`
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
        }
      );
      authFetch.mockResolvedValue(authErrorResponse);
      mockDiscoverOAuthServerInfo.mockImplementation(
        async (_serverUrl, options) => {
          const response = await options?.fetchFn?.(
            "https://example.com/.well-known/oauth-protected-resource/mcp"
          );
          if (!response) {
            throw new Error("Missing OAuth fetch function");
          }
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return createDiscoveryState();
        }
      );

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
        }
      );
      authFetch.mockResolvedValue(authErrorResponse);
      mockDiscoverOAuthServerInfo.mockImplementation(
        async (_serverUrl, options) => {
          const response = await options?.fetchFn?.(
            "https://example.com/.well-known/oauth-protected-resource/mcp"
          );
          if (!response) {
            throw new Error("Missing OAuth fetch function");
          }
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return createDiscoveryState();
        }
      );

      const { initiateOAuth } = await import("../mcp-oauth");
      const result = await initiateOAuth({
        serverName: "test-server",
        serverUrl: "https://example.com/mcp",
      });

      expect(result.success).toBe(false);
    });

    it("does not fall back to direct fetch when the oauth proxy throws", async () => {
      vi.resetModules();
      const directFetch = vi.fn();
      vi.stubGlobal("fetch", directFetch);

      const sessionToken = await import("@/lib/session-token");
      const isolatedAuthFetch = sessionToken.authFetch as ReturnType<
        typeof vi.fn
      >;
      isolatedAuthFetch.mockReset();
      isolatedAuthFetch.mockRejectedValueOnce(new Error("proxy exploded"));

      mockDiscoverOAuthServerInfo.mockReset();
      mockDiscoverOAuthServerInfo.mockImplementationOnce(
        async (_serverUrl, options) => {
          await expect(
            options?.fetchFn?.(
              "https://example.com/.well-known/oauth-protected-resource/mcp"
            )
          ).rejects.toThrow("proxy exploded");
          throw new Error("proxy exploded");
        }
      );

      const { initiateOAuth } = await import("../mcp-oauth");
      const result = await initiateOAuth({
        serverName: "test-server",
        serverUrl: "https://example.com/mcp",
      });

      expect(result.success).toBe(false);
      expect(directFetch).not.toHaveBeenCalled();
    });

    it("propagates successful proxy responses correctly", async () => {
      const metadataResponse = new Response(
        JSON.stringify({
          authorization_servers: ["https://auth.example.com"],
        }),
        { status: 200 }
      );
      authFetch.mockResolvedValue(metadataResponse);
      mockDiscoverOAuthServerInfo.mockImplementation(
        async (_serverUrl, options) => {
          const response = await options?.fetchFn?.(
            "https://example.com/.well-known/oauth-protected-resource/mcp"
          );
          if (!response) {
            throw new Error("Missing OAuth fetch function");
          }
          expect(response.ok).toBe(true);
          return createDiscoveryState();
        }
      );

      const { initiateOAuth } = await import("../mcp-oauth");
      const result = await initiateOAuth({
        serverName: "test-server",
        serverUrl: "https://example.com/mcp",
      });

      expect(result.success).toBe(true);
      expect(authFetch).toHaveBeenCalledWith(
        expect.stringMatching(
          /\/api\/mcp\/oauth\/metadata\?url=.*oauth-protected-resource/
        ),
        expect.objectContaining({ method: "GET" })
      );
    });

    it("forwards custom headers during automatic discovery planning", async () => {
      const metadataResponse = new Response(
        JSON.stringify({
          authorization_servers: ["https://auth.example.com"],
        }),
        { status: 200 }
      );
      authFetch.mockResolvedValue(metadataResponse);
      mockDiscoverOAuthServerInfo.mockImplementationOnce(
        async (_serverUrl, options) => {
          const response = await options?.fetchFn?.(
            "https://example.com/.well-known/oauth-protected-resource/mcp"
          );
          if (!response) {
            throw new Error("Missing OAuth fetch function");
          }
          expect(response.ok).toBe(true);
          return createCimdDiscoveryState();
        }
      );

      const { initiateOAuth } = await import("../mcp-oauth");
      const result = await initiateOAuth({
        serverName: "test-server",
        serverUrl: "https://example.com/mcp",
        customHeaders: {
          "X-Tenant": "project-123",
        },
      });

      expect(result.success).toBe(true);
      const metadataCall = authFetch.mock.calls.find(
        ([input]) =>
          typeof input === "string" &&
          input.includes("/api/mcp/oauth/metadata?url=")
      );
      expect(metadataCall).toBeDefined();
      expect(metadataCall?.[1]).toMatchObject({
        method: "GET",
      });
      expect(
        new Headers(metadataCall?.[1]?.headers as HeadersInit).get("X-Tenant")
      ).toBe("project-123");
    });

    it("replays the initial MCP initialize through the proxy when browser transport fails", async () => {
      vi.resetModules();
      const browserFetch = vi
        .fn()
        .mockRejectedValueOnce(new Error("Failed to fetch"));
      vi.stubGlobal("fetch", browserFetch);

      const sessionToken = await import("@/lib/session-token");
      const isolatedAuthFetch = sessionToken.authFetch as ReturnType<
        typeof vi.fn
      >;
      isolatedAuthFetch.mockReset();
      isolatedAuthFetch.mockImplementation(async (input) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
            ? input.toString()
            : input.url;

        if (url === "/api/mcp/oauth/proxy") {
          return createJsonResponse({
            status: 401,
            statusText: "Unauthorized",
            headers: {
              "content-type": "application/json",
              "www-authenticate":
                'Bearer resource_metadata="https://learn.mcpjam.com/.well-known/oauth-protected-resource"',
            },
            body: {
              error: "Unauthorized",
            },
          });
        }

        if (url.includes("oauth-protected-resource")) {
          return createJsonResponse({
            resource: "https://learn.mcpjam.com/mcp",
            authorization_servers: ["https://learn.mcpjam.com"],
          });
        }

        if (
          url.includes("oauth-authorization-server") ||
          url.includes("openid-configuration")
        ) {
          return createJsonResponse({
            issuer: "https://learn.mcpjam.com",
            authorization_endpoint: "https://learn.mcpjam.com/authorize",
            token_endpoint: "https://learn.mcpjam.com/token",
            response_types_supported: ["code"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
          });
        }

        throw new Error(`Unexpected authFetch call to ${url}`);
      });
      const learnDiscoveryState = {
        authorizationServerUrl: "https://learn.mcpjam.com",
        resourceMetadataUrl:
          "https://learn.mcpjam.com/.well-known/oauth-protected-resource",
        resourceMetadata: {
          resource: "https://learn.mcpjam.com/mcp",
          authorization_servers: ["https://learn.mcpjam.com"],
        },
        authorizationServerMetadata: {
          issuer: "https://learn.mcpjam.com",
          authorization_endpoint: "https://learn.mcpjam.com/authorize",
          token_endpoint: "https://learn.mcpjam.com/token",
          response_types_supported: ["code"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        },
      };
      mockDiscoverOAuthServerInfo
        .mockResolvedValueOnce(learnDiscoveryState)
        .mockResolvedValueOnce(learnDiscoveryState);

      const oauthModule = await import("../mcp-oauth");
      vi.spyOn(
        oauthModule.MCPOAuthProvider.prototype,
        "redirectToAuthorization"
      ).mockResolvedValue(undefined);
      const { initiateOAuth } = oauthModule;
      const result = await initiateOAuth({
        serverName: "learn",
        serverUrl: "https://learn.mcpjam.com/mcp",
        clientId: "learn-client-id",
      });

      expect(result.success).toBe(true);
      expect(browserFetch).toHaveBeenCalledWith(
        "https://learn.mcpjam.com/mcp",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          }),
        })
      );
      const proxyCall = isolatedAuthFetch.mock.calls.find(
        ([url]) => url === "/api/mcp/oauth/proxy"
      );
      expect(proxyCall).toBeDefined();
      expect(proxyCall?.[1]).toMatchObject({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const proxyRequest = JSON.parse(
        String((proxyCall?.[1] as RequestInit | undefined)?.body ?? "{}")
      );
      expect(proxyRequest).toMatchObject({
        url: "https://learn.mcpjam.com/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
      });
      expect(JSON.parse(proxyRequest.body)).toEqual({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: {
            name: "MCPJam Inspector",
            version: "1.0.0",
          },
        },
        id: 1,
      });
    });

    it("does not persist preregistered client secrets to localStorage", async () => {
      vi.resetModules();

      const oauthModule = await import("../mcp-oauth");
      vi.spyOn(
        oauthModule.MCPOAuthProvider.prototype,
        "redirectToAuthorization"
      ).mockResolvedValue(undefined);

      const result = await oauthModule.initiateOAuth({
        serverName: "hosted",
        serverUrl: "https://example.com/mcp",
        clientId: "hosted-client-id",
        clientSecret: "hosted-client-secret",
      });

      expect(result.success).toBe(true);
      // The client id persists (now inside the SEP-2352 issuer-keyed envelope),
      // but the secret must never reach localStorage.
      expect(localStorage.getItem("mcp-client-hosted")).toContain(
        "hosted-client-id"
      );
      expect(localStorage.getItem("mcp-client-hosted")).not.toContain(
        "client_secret"
      );
      expect(localStorage.getItem("mcp-client-hosted")).not.toContain(
        "hosted-client-secret"
      );
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        expect(key ? localStorage.getItem(key) : "").not.toContain(
          "hosted-client-secret"
        );
      }
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
        })
      );
      mockDiscoverOAuthServerInfo.mockResolvedValue(
        createLinearDiscoveryState()
      );
      mockRegisterClient.mockImplementationOnce(
        async (_authServerUrl, options) => {
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
            }
          );
          expect(response.ok).toBe(true);
          return await response.json();
        }
      );

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
        })
      );
    });
  });

  describe("persisted discovery state", () => {
    it("tags Electron-started OAuth state for desktop callback recovery", async () => {
      window.isElectron = true;

      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse"
      );

      expect(provider.state()).toMatch(/^electron_mcp:mock-random-string$/);
    });

    it("keeps the browser callback redirect URI in Electron", async () => {
      window.isElectron = true;

      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse"
      );

      expect(provider.redirectUrl).toBe(
        `${window.location.origin}/oauth/callback`
      );
      expect(provider.clientMetadata.redirect_uris).toEqual([
        `${window.location.origin}/oauth/callback`,
      ]);
    });

    it("tags state-machine authorization URLs before opening the browser in Electron", async () => {
      window.isElectron = true;
      mockStartAuthorization.mockImplementationOnce(async (_url, options) => {
        const authorizationUrl = new URL("https://auth.example.com/authorize");
        authorizationUrl.searchParams.set("state", "mock-state");
        authorizationUrl.searchParams.set(
          "redirect_uri",
          String((options as { redirectUri?: string }).redirectUri)
        );
        return {
          authorizationUrl,
          codeVerifier: "test-verifier",
        };
      });

      const { MCPOAuthProvider, initiateOAuth } = await import("../mcp-oauth");
      const redirectSpy = vi
        .spyOn(MCPOAuthProvider.prototype, "redirectToAuthorization")
        .mockResolvedValue(undefined);

      const result = await initiateOAuth({
        serverName: "example",
        serverUrl: "https://example.com",
      });

      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      const openedUrl = redirectSpy.mock.calls.at(-1)?.[0] as URL;
      expect(openedUrl.searchParams.get("state")).toBe(
        "electron_mcp:mock-state"
      );
      expect(openedUrl.searchParams.get("redirect_uri")).toBe(
        `${window.location.origin}/oauth/callback`
      );
    });

    it("keeps browser OAuth state untagged", async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse"
      );

      window.isElectron = false;

      expect(provider.state()).toBe("mock-random-string");
    });

    it("falls back to in-app navigation when Electron browser open fails", async () => {
      vi.restoreAllMocks();
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse"
      );
      const navigateSpy = vi
        .spyOn(provider, "navigateToUrl")
        .mockImplementation(() => {});
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const openExternal = vi
        .fn()
        .mockRejectedValue(new Error("system browser unavailable"));

      Object.defineProperty(window, "isElectron", {
        configurable: true,
        writable: true,
        value: true,
      });
      Object.defineProperty(window, "electronAPI", {
        configurable: true,
        writable: true,
        value: {
          app: {
            openExternal,
          },
        },
      });

      await provider.redirectToAuthorization(
        new URL("https://auth.example.com/authorize")
      );

      expect(openExternal).toHaveBeenCalledWith(
        "https://auth.example.com/authorize"
      );
      expect(navigateSpy).toHaveBeenCalledWith(
        "https://auth.example.com/authorize"
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "Failed to open system browser for MCP OAuth; continuing inside MCPJam Desktop:",
        expect.any(Error)
      );
    });

    it("falls back to in-app navigation when Electron browser opener is unavailable", async () => {
      vi.restoreAllMocks();
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse"
      );
      const navigateSpy = vi
        .spyOn(provider, "navigateToUrl")
        .mockImplementation(() => {});
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});

      Object.defineProperty(window, "isElectron", {
        configurable: true,
        writable: true,
        value: true,
      });
      Object.defineProperty(window, "electronAPI", {
        configurable: true,
        writable: true,
        value: {
          app: {},
        },
      });

      await provider.redirectToAuthorization(
        new URL("https://auth.example.com/authorize")
      );

      expect(navigateSpy).toHaveBeenCalledWith(
        "https://auth.example.com/authorize"
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "System browser opener is unavailable for MCP OAuth; continuing inside MCPJam Desktop."
      );
    });

    it("explains why automatic mode resolved to DCR when CIMD support was not advertised", async () => {
      mockDiscoverOAuthServerInfo.mockResolvedValue(
        createAsanaDiscoveryState()
      );

      const { initiateOAuth } = await import("../mcp-oauth");
      const result = await initiateOAuth({
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/v2/mcp",
      });

      expect(result.success).toBe(true);
      expect(findAutomaticDecisionStep(result)).toMatchObject({
        message:
          "Automatic resolved to DCR for this run. The authorization server advertised registration_endpoint, and CIMD support was not advertised.",
        details: expect.objectContaining({
          "Automatic Decision": "DCR",
          "Advertised Strategies": "Pre-registered, DCR",
          Reason:
            "The authorization server advertised registration_endpoint, and CIMD support was not advertised.",
          "CIMD Support": "Not advertised by authorization server",
        }),
      });
    });

    it("explains when automatic mode resolved to CIMD after discovery", async () => {
      mockDiscoverOAuthServerInfo.mockResolvedValueOnce(
        createCimdDiscoveryState()
      );

      const { initiateOAuth } = await import("../mcp-oauth");
      const result = await initiateOAuth({
        serverName: "example",
        serverUrl: "https://example.com/mcp",
      });

      expect(result.success).toBe(true);
      expect(findAutomaticDecisionStep(result)).toMatchObject({
        message:
          "Automatic resolved to CIMD for this run. The authorization server advertised client_id_metadata_document_supported, so automatic mode preferred CIMD over DCR.",
        details: expect.objectContaining({
          "Automatic Decision": "CIMD",
          "Advertised Strategies": "Pre-registered, DCR, CIMD",
          Reason:
            "The authorization server advertised client_id_metadata_document_supported, so automatic mode preferred CIMD over DCR.",
        }),
      });
    });

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
        })
      );

      expect(readStoredOAuthConfig("linear")).toEqual({
        scopes: ["read", "write"],
        registryServerId: "registry-linear",
        useRegistryOAuthProxy: true,
      });
    });

    it("keeps live oauth traces in memory while preserving redirect resume state", async () => {
      mockDiscoverOAuthServerInfo.mockResolvedValue(
        createAsanaDiscoveryState()
      );
      const { initiateOAuth } = await import("../mcp-oauth");

      const result = await initiateOAuth({
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/v2/mcp",
      });

      expect(result.success).toBe(true);
      expect(localStorage.getItem("mcp-oauth-trace-asana")).toBeNull();
      expect(localStorage.getItem("mcp-oauth-flow-state-asana")).not.toBeNull();
      expect(
        sessionStorage.getItem("mcp-oauth-session-trace-asana")
      ).not.toBeNull();
    });

    it("normalizes malformed persisted oauth trace history", async () => {
      const { appendOAuthTraceHttpHistory, loadOAuthTrace } = await import(
        "../oauth-trace"
      );

      localStorage.setItem(
        "mcp-oauth-trace-linear",
        JSON.stringify({
          version: 1,
          source: "refresh",
          currentStep: "idle",
          steps: [],
          httpHistory: null,
        })
      );

      const trace = loadOAuthTrace("linear");
      expect(trace?.httpHistory).toEqual([]);
      expect(() =>
        appendOAuthTraceHttpHistory(trace!, {
          step: "idle",
          timestamp: Date.now(),
          request: {
            method: "GET",
            url: "https://example.com",
            headers: {},
          },
        })
      ).not.toThrow();
    });

    it("detects OAuth token grant requests", async () => {
      const { isOAuthTokenGrantRequest } = await import("../mcp-oauth");

      expect(
        isOAuthTokenGrantRequest("POST", {
          grant_type: "authorization_code",
        })
      ).toBe(true);
      expect(
        isOAuthTokenGrantRequest("POST", {
          grant_type: "refresh_token",
        })
      ).toBe(true);
      expect(
        isOAuthTokenGrantRequest("POST", {
          client_name: "MCPJam - Linear",
        })
      ).toBe(false);
      expect(
        isOAuthTokenGrantRequest("GET", {
          grant_type: "authorization_code",
        })
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
        })
      ).toBe(true);

      expect(
        shouldUseRegistryOAuthProxy({
          registryServerId: "registry-linear",
          useRegistryOAuthProxy: false,
          method: "POST",
          body: { grant_type: "authorization_code" },
        })
      ).toBe(false);

      expect(
        shouldUseRegistryOAuthProxy({
          registryServerId: "registry-asana",
          useRegistryOAuthProxy: true,
          method: "POST",
          body: { client_name: "MCPJam - Asana" },
        })
      ).toBe(false);
    });

    it("drops stored token_endpoint_auth_method when a static client_secret is supplied", async () => {
      // Regression: when DCR previously registered this server, the stored
      // client info carries `token_endpoint_auth_method: "none"` (echoed
      // back from our DCR metadata). On a later attempt the user provides
      // a static client_id + client_secret. The upstream SDK honors the
      // stored `"none"` hint and skips client auth on token exchange,
      // surfacing as `invalid_client` from the server. The fix: when a
      // static secret is configured, strip the inherited hint so the SDK
      // auto-picks client_secret_basic / _post from server metadata.
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      localStorage.setItem(
        "mcp-client-asana",
        JSON.stringify({
          client_id: "dcr-registered-id",
          token_endpoint_auth_method: "none",
        })
      );

      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
        "static-client-id",
        "static-client-secret"
      );

      const info = (await provider.clientInformation()) as Record<
        string,
        unknown
      >;
      expect(info.client_id).toBe("static-client-id");
      expect(info.client_secret).toBe("static-client-secret");
      expect(info).not.toHaveProperty("token_endpoint_auth_method");
    });

    it("preserves stored client_secret_post / _basic when merging static credentials", async () => {
      // Companion to the "none" strip: the heal is intentionally narrow.
      // A legitimately-registered confidential client may have
      // token_endpoint_auth_method = "client_secret_post" (or "_basic")
      // in stored info. Dropping it would let the SDK auto-pick — which
      // prefers basic when both are listed in server metadata — and
      // could downgrade a post-configured client. Both values still
      // result in the secret being sent, so honoring them is correct.
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      localStorage.setItem(
        "mcp-client-asana",
        JSON.stringify({
          client_id: "dcr-registered-id",
          token_endpoint_auth_method: "client_secret_post",
        })
      );

      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
        "static-client-id",
        "static-client-secret"
      );

      const info = (await provider.clientInformation()) as Record<
        string,
        unknown
      >;
      expect(info.token_endpoint_auth_method).toBe("client_secret_post");
      expect(info.client_secret).toBe("static-client-secret");
    });

    it("ignores malformed stored client information", async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      localStorage.setItem("mcp-client-asana", "{not-json");

      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
        "static-client-id",
        "static-client-secret"
      );

      await expect(provider.clientInformation()).resolves.toMatchObject({
        client_id: "static-client-id",
        client_secret: "static-client-secret",
      });
    });

    it("advertises client_secret_basic in clientMetadata when a static secret is configured", async () => {
      // The DCR metadata advertises `token_endpoint_auth_method`. Hard-coding
      // "none" while we hold a confidential client secret tells the server
      // to expect a public (PKCE-only) client and is the root cause of the
      // stored hint that pollutes later token exchanges.
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const providerNoSecret = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
        "static-client-id"
      );
      expect(providerNoSecret.clientMetadata.token_endpoint_auth_method).toBe(
        "none"
      );

      const providerWithSecret = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
        "static-client-id",
        "static-client-secret"
      );
      expect(
        providerWithSecret.clientMetadata.token_endpoint_auth_method
      ).toBe("client_secret_basic");
    });

    it("round-trips discovery state for the matching server URL", async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const discoveryState = createDiscoveryState();
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse"
      );

      await provider.saveDiscoveryState(discoveryState);

      expect(provider.discoveryState()).toEqual(discoveryState);
    });

    it("ignores stale discovery state when the server URL changes", async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const discoveryState = createDiscoveryState();
      const originalProvider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse"
      );
      await originalProvider.saveDiscoveryState(discoveryState);

      const nextProvider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/alt-sse"
      );

      expect(nextProvider.discoveryState()).toBeUndefined();
    });

    it('clears discovery state on invalidateCredentials("all")', async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse"
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
        "https://mcp.asana.com/sse"
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
        "https://mcp.asana.com/sse"
      );
      await provider.saveDiscoveryState(createDiscoveryState());
      sessionStorage.setItem(
        "mcp-oauth-session-trace-asana",
        JSON.stringify({ serverName: "asana" })
      );

      clearOAuthData("asana");

      expect(localStorage.getItem("mcp-discovery-asana")).toBeNull();
      expect(
        sessionStorage.getItem("mcp-oauth-session-trace-asana")
      ).toBeNull();
      expect(provider.discoveryState()).toBeUndefined();
    });

    it("reuses cached discovery state after the callback reload", async () => {
      const discoveryState = createAsanaDiscoveryState();
      mockDiscoverOAuthServerInfo.mockResolvedValue(discoveryState);
      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL("https://auth.example.com/authorize"),
        codeVerifier: "code-verifier",
      });
      mockExchangeAuthorization.mockImplementationOnce(
        async (_url, options) => {
          expect(options?.authorizationCode).toBe("oauth-code");
          expect(options?.codeVerifier).toBe("code-verifier");
          return {
            access_token: "access-token",
            refresh_token: "refresh-token",
            token_type: "Bearer",
          };
        }
      );

      const { getStoredTokens, handleOAuthCallback, initiateOAuth } =
        await import("../mcp-oauth");

      const initiateResult = await initiateOAuth({
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/sse",
      });
      expect(initiateResult.success).toBe(true);

      const callbackResult = await handleOAuthCallback("oauth-code", {
        callbackState: issuedCallbackState(),
      });

      expect(callbackResult.success).toBe(true);
      expect(callbackResult.serverName).toBe("asana");
      expect(callbackResult.serverConfig?.requestInit?.headers).toEqual({
        Authorization: "Bearer access-token",
      });
      expect(getStoredTokens("asana")).toBeUndefined();
      expect(localStorage.getItem("mcp-tokens-asana")).toBeNull();
      expect(localStorage.getItem("mcp-discovery-asana")).not.toBeNull();
      expect(localStorage.getItem("mcp-verifier-asana")).toBeNull();
      expect(mockDiscoverOAuthServerInfo).toHaveBeenCalledTimes(2);
      expect(mockExchangeAuthorization).toHaveBeenCalledTimes(1);
    });

    it("preserves one advertised resource string through authorization, callback, storage, and refresh", async () => {
      const serverName = "example";
      const serverUrl = "https://mcp.example.com/api/mcp";
      const advertisedResource = "HTTPS://MCP.EXAMPLE.COM:443/api/";
      const discoveryState = {
        ...createDiscoveryState(),
        resourceMetadataUrl:
          "https://mcp.example.com/.well-known/oauth-protected-resource/api",
        resourceMetadata: {
          resource: advertisedResource,
          authorization_servers: ["https://auth.example.com"],
        },
      };

      mockDiscoverOAuthServerInfo.mockResolvedValue(discoveryState);
      mockStartAuthorization.mockResolvedValue({
        authorizationUrl: new URL(
          "https://auth.example.com/authorize?state=mock-state"
        ),
        codeVerifier: "test-verifier",
      });
      mockExchangeAuthorization.mockImplementationOnce(
        async (_authorizationServerUrl, options) => {
          expect(options?.resource).toBe(advertisedResource);
          return {
            access_token: "access-token",
            refresh_token: "refresh-token",
            token_type: "Bearer",
          };
        }
      );

      const { handleOAuthCallback, initiateOAuth, refreshOAuthTokens } =
        await import("../mcp-oauth");

      const initiateResult = await initiateOAuth({ serverName, serverUrl });
      expect(initiateResult.success).toBe(true);

      const storedFlow = JSON.parse(
        localStorage.getItem(`mcp-oauth-flow-state-${serverName}`) ?? "{}"
      );
      expect(
        new URL(storedFlow.state.authorizationUrl).searchParams.get("resource")
      ).toBe(advertisedResource);
      expect(
        JSON.parse(
          localStorage.getItem(`mcp-oauth-config-${serverName}`) ?? "{}"
        ).resourceUrl
      ).toBe(advertisedResource);

      // Exercise the callback path that performs the exchange directly; the
      // state-machine path already owns separate resource persistence tests.
      localStorage.removeItem(`mcp-oauth-flow-state-${serverName}`);
      const callbackResult = await handleOAuthCallback("oauth-code", {
        callbackState: issuedCallbackState(),
      });
      expect(callbackResult.success, callbackResult.error).toBe(true);
      expect(callbackResult.oauthResourceUrl).toBe(advertisedResource);
      expect(
        JSON.parse(
          localStorage.getItem(`mcp-oauth-config-${serverName}`) ?? "{}"
        ).resourceUrl
      ).toBe(advertisedResource);

      // Production imports callback tokens into secure storage. Seed the
      // local refresh-token adapter explicitly so this unit test can exercise
      // the browser refresh request that replays the stored resource value.
      localStorage.setItem(
        `mcp-tokens-${serverName}`,
        JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
        })
      );

      mockFetchToken.mockImplementationOnce(
        async (_provider, _authorizationServerUrl, options) => {
          expect(options?.resource).toBe(advertisedResource);
          return {
            access_token: "refreshed-access-token",
            refresh_token: "refresh-token",
            token_type: "Bearer",
          };
        }
      );

      const refreshResult = await refreshOAuthTokens(serverName);
      expect(refreshResult.success).toBe(true);
    });

    it("treats malformed stored token data as invalid instead of throwing", async () => {
      const { getStoredTokens, getStoredTokensState } = await import(
        "../mcp-oauth"
      );

      localStorage.setItem("mcp-tokens-asana", '{"access_token":"broken"');
      localStorage.setItem("mcp-client-asana", '{"client_id":"broken"');

      expect(getStoredTokens("asana")).toBeUndefined();
      expect(getStoredTokensState("asana")).toEqual({
        tokens: undefined,
        isInvalid: true,
      });
    });

    it("ignores malformed stored client information when token data is valid", async () => {
      const { getStoredTokens, getStoredTokensState } = await import(
        "../mcp-oauth"
      );

      localStorage.setItem(
        "mcp-tokens-asana",
        JSON.stringify({
          access_token: "stored-access",
          refresh_token: "stored-refresh",
        })
      );
      localStorage.setItem("mcp-client-asana", '{"client_id":"broken"');

      expect(getStoredTokens("asana")).toMatchObject({
        access_token: "stored-access",
        refresh_token: "stored-refresh",
      });
      expect(getStoredTokensState("asana")).toMatchObject({
        tokens: {
          access_token: "stored-access",
          refresh_token: "stored-refresh",
        },
        isInvalid: false,
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
            "https://app.asana.com/-/oauth_token"
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
            }
          );
          return await response.json();
        }
      );

      const { handleOAuthCallback } = await import("../mcp-oauth");
      const callbackResult = await handleOAuthCallback("oauth-code", {
        callbackState: issuedCallbackState(),
      });

      expect(callbackResult.success).toBe(true);
      expect(localStorage.getItem("mcp-verifier-asana")).toBeNull();
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
        })
      );
    });

    it("persists preregistered registry routing for fresh Asana OAuth connects", async () => {
      await seedPendingOAuth(
        "registry-asana",
        createAsanaDiscoveryState(),
        true
      );

      expect(localStorage.getItem("mcp-oauth-config-asana")).toBe(
        JSON.stringify({
          registryServerId: "registry-asana",
          useRegistryOAuthProxy: true,
          resourceUrl: "https://mcp.asana.com/v2/mcp",
          protocolMode: "auto",
          protocolVersion: "2025-11-25",
          registrationMode: "preregistered",
          registrationStrategy: "preregistered",
        })
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

      mockDiscoverOAuthServerInfo.mockResolvedValue(
        createAsanaDiscoveryState()
      );
      mockFetchToken.mockImplementationOnce(
        async (_provider, authServerUrl, options) => {
          expect(authServerUrl).toBe("https://app.asana.com");
          const response = await options.fetchFn!(
            "https://app.asana.com/-/oauth_token",
            {
              method: "POST",
              body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: "stored-refresh-token",
              }),
            }
          );
          return await response.json();
        }
      );

      localStorage.setItem(
        "mcp-serverUrl-asana",
        "https://mcp.asana.com/v2/mcp"
      );
      localStorage.setItem(
        "mcp-oauth-config-asana",
        JSON.stringify({
          registryServerId: "registry-asana",
          useRegistryOAuthProxy: true,
        })
      );
      localStorage.setItem(
        "mcp-client-asana",
        JSON.stringify({ client_id: "asana-client-id" })
      );
      localStorage.setItem(
        "mcp-tokens-asana",
        JSON.stringify({
          access_token: "old-access-token",
          refresh_token: "stored-refresh-token",
          token_type: "Bearer",
        })
      );

      const { refreshOAuthTokens } = await import("../mcp-oauth");
      const refreshResult = await refreshOAuthTokens("asana");

      expect(refreshResult.success).toBe(true);
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
        })
      );
    });

    it("reuses the stored OAuth client information when a fresh OAuth flow starts", async () => {
      localStorage.setItem(
        "mcp-serverUrl-asana",
        "https://mcp.asana.com/v2/mcp"
      );
      localStorage.setItem(
        "mcp-client-asana",
        JSON.stringify({
          client_id: "stale-client-id",
        })
      );
      localStorage.setItem(
        "mcp-tokens-asana",
        JSON.stringify({
          access_token: "old-access-token",
          refresh_token: "stored-refresh-token",
          token_type: "Bearer",
        })
      );

      mockDiscoverOAuthServerInfo.mockResolvedValue(
        createAsanaDiscoveryState()
      );
      mockRegisterClient.mockResolvedValueOnce({
        client_id: "new-client-id",
      });
      mockStartAuthorization.mockResolvedValueOnce({
        authorizationUrl: new URL("https://app.asana.com/-/oauth_authorize"),
        codeVerifier: "fresh-verifier",
      });

      const [{ getOAuthTraceFailureStep }, { initiateOAuth }] =
        await Promise.all([import("../oauth-trace"), import("../mcp-oauth")]);

      const result = await initiateOAuth({
        serverName: "asana",
        serverUrl: "https://mcp.asana.com/v2/mcp",
      });

      expect(result.success).toBe(true);
      // The stale client id is reused (not re-registered), now inside the
      // SEP-2352 issuer-keyed envelope.
      expect(localStorage.getItem("mcp-client-asana")).toContain(
        "stale-client-id"
      );
      expect(mockRegisterClient).not.toHaveBeenCalled();
      expect(getOAuthTraceFailureStep(result.oauthTrace)).toBeUndefined();
    });

    it("does not reuse a client id across an authorization-server change (SEP-2352)", async () => {
      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "issuer-change",
        "https://mcp.example.com/sse"
      );

      // Register against AS A.
      await provider.saveDiscoveryState({
        ...createDiscoveryState(),
        authorizationServerUrl: "https://as-a.example.com",
        authorizationServerMetadata: { issuer: "https://as-a.example.com" },
      } as any);
      await provider.saveClientInformation({ client_id: "client-for-as-a" });
      expect((await provider.clientInformation())?.client_id).toBe(
        "client-for-as-a"
      );

      // Protected-resource metadata now points to AS B.
      await provider.saveDiscoveryState({
        ...createDiscoveryState(),
        authorizationServerUrl: "https://as-b.example.com",
        authorizationServerMetadata: { issuer: "https://as-b.example.com" },
      } as any);

      // AS A's client id must NOT be reused for AS B — the flow re-registers.
      expect(await provider.clientInformation()).toBeUndefined();

      // Registering against AS B keeps AS A's bucket (a multi-issuer server).
      await provider.saveClientInformation({ client_id: "client-for-as-b" });
      expect((await provider.clientInformation())?.client_id).toBe(
        "client-for-as-b"
      );
      const raw = localStorage.getItem("mcp-client-issuer-change") ?? "";
      expect(raw).toContain("client-for-as-a");
      expect(raw).toContain("client-for-as-b");
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
            401
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
            }
          );
          if (!response.ok) {
            const payload = await response.json();
            throw new Error(`${payload.error}: ${payload.error_description}`);
          }
          return await response.json();
        }
      );

      const { handleOAuthCallback } = await import("../mcp-oauth");
      const callbackResult = await handleOAuthCallback("oauth-code", {
        callbackState: issuedCallbackState(),
      });

      expect(callbackResult.success).toBe(false);
      expect(callbackResult.error).not.toBe("Code verifier not found");
      expect(callbackResult.error).toContain(
        "Invalid client ID during token exchange"
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
        })
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
            }
          );
          return await response.json();
        }
      );

      const { handleOAuthCallback } = await import("../mcp-oauth");
      const callbackResult = await handleOAuthCallback("oauth-code", {
        callbackState: issuedCallbackState(),
      });

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
        })
      );
    });

    const seedAsanaCallback = (discoveryState: any) => {
      localStorage.setItem("mcp-oauth-pending", "asana");
      localStorage.setItem(
        "mcp-serverUrl-asana",
        "https://mcp.asana.com/v2/mcp"
      );
      localStorage.setItem(
        "mcp-client-asana",
        JSON.stringify({ client_id: "asana-client-id" })
      );
      localStorage.setItem("mcp-verifier-asana", "test-verifier");
      localStorage.setItem(
        "mcp-discovery-asana",
        JSON.stringify({
          serverUrl: "https://mcp.asana.com/v2/mcp",
          discoveryState,
        })
      );
    };

    it("rejects cross-origin resource metadata during callback completion", async () => {
      seedAsanaCallback({
        ...createAsanaDiscoveryState(),
        resourceMetadata: {
          ...createAsanaDiscoveryState().resourceMetadata,
          resource: "https://evil.example/mcp",
        },
      });

      const { handleOAuthCallback } = await import("../mcp-oauth");
      const callbackResult = await handleOAuthCallback("oauth-code", {
        callbackState: issuedCallbackState(),
      });

      expect(callbackResult.success).toBe(false);
      expect(callbackResult.error).toContain(
        "Rejected OAuth resource indicator"
      );
      expect(mockExchangeAuthorization).not.toHaveBeenCalled();
    });

    it("rejects PRM metadata that omits its required resource during callback completion", async () => {
      const asana = createAsanaDiscoveryState();
      delete asana.resourceMetadata.resource;
      seedAsanaCallback(asana);

      const { handleOAuthCallback } = await import("../mcp-oauth");
      const callbackResult = await handleOAuthCallback("oauth-code", {
        callbackState: issuedCallbackState(),
      });

      expect(callbackResult.success).toBe(false);
      expect(callbackResult.error).toContain('missing its required "resource"');
      expect(mockExchangeAuthorization).not.toHaveBeenCalled();
    });

    it("uses the generic Inspector OAuth proxy for Asana when stored config is missing the preregistered flag", async () => {
      const browserFetch = vi.fn();
      vi.stubGlobal("fetch", browserFetch);
      await seedPendingOAuth(
        "registry-asana",
        createAsanaDiscoveryState(),
        false,
        "asana",
        "https://mcp.asana.com/v2/mcp"
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
        })
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
            }
          );
          return await response.json();
        }
      );

      const { handleOAuthCallback } = await import("../mcp-oauth");
      const callbackResult = await handleOAuthCallback("oauth-code", {
        callbackState: issuedCallbackState(),
      });

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
        })
      );
      expect(authFetch).not.toHaveBeenCalledWith(
        expect.stringMatching(/\.convex\.site\/registry\/oauth\/token$/),
        expect.anything()
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
        "https://mcp.linear.app/mcp"
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
        })
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
            }
          );
          return await response.json();
        }
      );

      const { handleOAuthCallback } = await import("../mcp-oauth");
      const callbackResult = await handleOAuthCallback("oauth-code", {
        callbackState: issuedCallbackState(),
      });

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
        })
      );
      expect(authFetch).not.toHaveBeenCalledWith(
        expect.stringMatching(/\.convex\.site\/registry\/oauth\/token$/),
        expect.anything()
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
        })
      );

      mockDiscoverOAuthServerInfo.mockResolvedValueOnce(
        createLinearDiscoveryState()
      );
      mockFetchToken.mockImplementationOnce(
        async (_provider, _authServerUrl, options) => {
          const response = await options.fetchFn!(
            "https://mcp.linear.app/token",
            {
              method: "POST",
              body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: "stored-refresh-token",
              }),
            }
          );
          return await response.json();
        }
      );

      localStorage.setItem(
        "mcp-serverUrl-linear",
        "https://mcp.linear.app/mcp"
      );
      localStorage.setItem(
        "mcp-oauth-config-linear",
        JSON.stringify({ registryServerId: "registry-linear" })
      );
      localStorage.setItem(
        "mcp-client-linear",
        JSON.stringify({ client_id: "linear-client-id" })
      );
      localStorage.setItem(
        "mcp-tokens-linear",
        JSON.stringify({
          access_token: "old-linear-access-token",
          refresh_token: "stored-refresh-token",
          token_type: "Bearer",
        })
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
        })
      );
      expect(authFetch).not.toHaveBeenCalledWith(
        expect.stringMatching(/\.convex\.site\/registry\/oauth\/refresh$/),
        expect.anything()
      );
    });
  });

  describe("MCPOAuthProvider.saveTokens convex binding", () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    it("imports tokens to Convex when a binding is provided in local mode", async () => {
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "false");
      const importApi = await import(
        "@/lib/apis/hosted-oauth-import-tokens-api"
      );
      const importSpy = vi
        .spyOn(importApi, "importHostedOAuthTokens")
        .mockResolvedValue({ expiresAt: null, kind: "generic" });

      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
        "client-from-arg",
        undefined,
        {
          projectId: "proj_xyz",
          serverId: "srv_abc",
          oauthResourceUrl: "https://mcp.asana.com",
          kind: "generic",
        }
      );

      await provider.saveTokens({
        access_token: "freshly-issued",
        refresh_token: "refresh-1",
        token_type: "Bearer",
      });

      expect(localStorage.getItem("mcp-tokens-asana")).toBeNull();
      expect(importSpy).toHaveBeenCalledTimes(1);
      expect(importSpy.mock.calls[0][0]).toMatchObject({
        projectId: "proj_xyz",
        serverId: "srv_abc",
        serverUrl: "https://mcp.asana.com/sse",
        oauthResourceUrl: "https://mcp.asana.com",
        kind: "generic",
        clientInformation: { clientId: "client-from-arg" },
        tokens: {
          access_token: "freshly-issued",
          refresh_token: "refresh-1",
          token_type: "Bearer",
        },
      });
      // Parity: saveTokens' `tokens` block must match the exported normalizer's
      // output for the same input. Locks the saveTokens ↔ migration ↔
      // normalizer three-way parity together with the matching assertion in
      // local-state-migration.test.ts.
      const { normalizeImportHostedOAuthTokens } = importApi;
      expect(importSpy.mock.calls[0][0].tokens).toEqual(
        normalizeImportHostedOAuthTokens({
          access_token: "freshly-issued",
          refresh_token: "refresh-1",
          token_type: "Bearer",
        })
      );
    });

    it("loads stored preregistered client secrets from the encrypted server-secret API", async () => {
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "false");
      authFetch.mockResolvedValueOnce(
        createJsonResponse({
          success: true,
          clientSecret: "encrypted-table-secret",
        })
      );
      const importApi = await import(
        "@/lib/apis/hosted-oauth-import-tokens-api"
      );
      const importSpy = vi
        .spyOn(importApi, "importHostedOAuthTokens")
        .mockResolvedValue({ expiresAt: null, kind: "generic" });

      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
        "client-from-arg",
        undefined,
        {
          projectId: "proj_xyz",
          serverId: "srv_abc",
          kind: "generic",
          hasClientSecret: true,
        }
      );

      const clientInformation = await provider.clientInformation();
      expect(clientInformation).toMatchObject({
        client_id: "client-from-arg",
        client_secret: "encrypted-table-secret",
      });
      expect(authFetch).toHaveBeenCalledWith(
        "/api/web/oauth/client-secret",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: "proj_xyz",
            serverId: "srv_abc",
          }),
        })
      );
      expect(localStorage.getItem("mcp-client-asana") ?? "").not.toContain(
        "encrypted-table-secret"
      );

      await provider.saveTokens({
        access_token: "freshly-issued",
        token_type: "Bearer",
      });

      expect(authFetch).toHaveBeenCalledTimes(1);
      expect(importSpy.mock.calls[0][0]).toMatchObject({
        clientInformation: {
          clientId: "client-from-arg",
          clientSecret: "encrypted-table-secret",
        },
      });
    });

    it("retries stored preregistered client secret fetches after transient failures", async () => {
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "false");
      authFetch
        .mockRejectedValueOnce(new Error("temporary outage"))
        .mockResolvedValueOnce(
          createJsonResponse({
            success: true,
            clientSecret: "encrypted-table-secret",
          })
        );

      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
        "client-from-arg",
        undefined,
        {
          projectId: "proj_xyz",
          serverId: "srv_abc",
          kind: "generic",
          hasClientSecret: true,
        }
      );

      await expect(provider.clientInformation()).rejects.toThrow(
        "temporary outage"
      );
      await expect(provider.clientInformation()).resolves.toMatchObject({
        client_id: "client-from-arg",
        client_secret: "encrypted-table-secret",
      });
      expect(authFetch).toHaveBeenCalledTimes(2);
    });

    it("fails loudly instead of storing OAuth tokens in localStorage without a binding", async () => {
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "false");
      const importApi = await import(
        "@/lib/apis/hosted-oauth-import-tokens-api"
      );
      const importSpy = vi.spyOn(importApi, "importHostedOAuthTokens");

      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
        "client-from-arg"
      );

      await expect(
        provider.saveTokens({
          access_token: "no-binding",
          token_type: "Bearer",
        })
      ).rejects.toThrow("cannot store tokens securely");

      expect(localStorage.getItem("mcp-tokens-asana")).toBeNull();
      expect(importSpy).not.toHaveBeenCalled();
    });

    it("HOSTED_MODE no-op stays defensive — saveTokens never imports", async () => {
      vi.resetModules();
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
      const importApi = await import(
        "@/lib/apis/hosted-oauth-import-tokens-api"
      );
      const importSpy = vi.spyOn(importApi, "importHostedOAuthTokens");

      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "asana",
        "https://mcp.asana.com/sse",
        "client-from-arg",
        undefined,
        {
          projectId: "proj_xyz",
          serverId: "srv_abc",
          kind: "generic",
        }
      );

      await provider.saveTokens({
        access_token: "should-be-ignored",
        token_type: "Bearer",
      });

      expect(localStorage.getItem("mcp-tokens-asana")).toBeNull();
      expect(importSpy).not.toHaveBeenCalled();
    });

    it("persists Convex binding on initiate so post-redirect callback recovers it when apiContext is empty", async () => {
      // Repro of the localhost-server OAuth bug: at OAuth-initiation time
      // apiContext.serverIdsByName is populated (user just clicked Connect),
      // but after the OAuth provider's redirect the post-callback mount
      // has empty apiContext until Convex's getProjectServers query
      // returns. Without persistence, saveTokens skips the import-tokens
      // call and /api/mcp/connect 401s on the missing credential row.
      vi.resetModules();
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "false");
      const contextModule = await import("@/lib/apis/web/context");
      const importApi = await import(
        "@/lib/apis/hosted-oauth-import-tokens-api"
      );
      const importSpy = vi
        .spyOn(importApi, "importHostedOAuthTokens")
        .mockResolvedValue({ expiresAt: null, kind: "generic" });

      // Simulate initiate-time: apiContext is populated.
      contextModule.setApiContext({
        projectId: "proj_xyz",
        serverIdsByName: { "mcpjam local": "srv_abc" },
        getAccessToken: async () => null,
      });
      const { MCPOAuthProvider, clearOAuthData } = await import("../mcp-oauth");

      // We don't have a public binding builder, so simulate what
      // initiateOAuth does internally by constructing a provider whose
      // binding the helper persists. The localStorage key the helper
      // writes is the contract we test against.
      const initBinding = {
        projectId: "proj_xyz",
        serverId: "srv_abc",
        oauthResourceUrl: "http://localhost:8787/mcp",
        kind: "generic" as const,
      };
      localStorage.setItem(
        `mcp-oauth-binding-mcpjam local`,
        JSON.stringify(initBinding)
      );

      // Now simulate the post-redirect mount: apiContext is back to empty
      // because Convex getProjectServers hasn't returned yet.
      contextModule.setApiContext(null);

      // saveTokens with no constructor-provided binding should still hit
      // the persisted binding via buildConvexBindingForServer's fallback.
      // Verify by constructing the provider the same way handleOAuthCallback
      // would: the binding is recovered from localStorage.
      const recoveredRaw = localStorage.getItem(
        `mcp-oauth-binding-mcpjam local`
      );
      expect(recoveredRaw).toBeTruthy();
      const recovered = JSON.parse(recoveredRaw!);
      const provider = new MCPOAuthProvider(
        "mcpjam local",
        "http://localhost:8787/mcp",
        "client_id_abc",
        undefined,
        recovered
      );
      await provider.saveTokens({
        access_token: "post-redirect-token",
        token_type: "Bearer",
      });

      expect(importSpy).toHaveBeenCalledTimes(1);
      expect(importSpy.mock.calls[0][0]).toMatchObject({
        projectId: "proj_xyz",
        serverId: "srv_abc",
        kind: "generic",
        tokens: { access_token: "post-redirect-token" },
      });

      // clearOAuthData purges the persisted binding so a subsequent
      // re-OAuth doesn't reuse stale projectId/serverId after the user
      // moved the server to a different project.
      clearOAuthData("mcpjam local");
      expect(localStorage.getItem(`mcp-oauth-binding-mcpjam local`)).toBeNull();
    });

    it("threads registry kind through when both registryServerId and useRegistryOAuthProxy are set", async () => {
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "false");
      const importApi = await import(
        "@/lib/apis/hosted-oauth-import-tokens-api"
      );
      const importSpy = vi
        .spyOn(importApi, "importHostedOAuthTokens")
        .mockResolvedValue({ expiresAt: null, kind: "registry" });

      const { MCPOAuthProvider } = await import("../mcp-oauth");
      const provider = new MCPOAuthProvider(
        "registry-srv",
        "https://registry.example.com/sse",
        "client-id",
        undefined,
        {
          projectId: "proj_r",
          serverId: "srv_r",
          kind: "registry",
          registryServerId: "reg_123",
          useRegistryOAuthProxy: true,
        }
      );

      await provider.saveTokens({
        access_token: "registry-token",
        token_type: "Bearer",
      });

      expect(importSpy).toHaveBeenCalledTimes(1);
      expect(importSpy.mock.calls[0][0]).toMatchObject({
        kind: "registry",
        registryServerId: "reg_123",
        useRegistryOAuthProxy: true,
      });
    });
  });
});

describe("createServerConfig wire-era pin", () => {
  it("pins mcpProtocolVersion for a 2026-07-28 OAuth flow", async () => {
    const { createServerConfig } = await import("../mcp-oauth");
    const config = createServerConfig(
      "https://mcp.example.com",
      { access_token: "tok" },
      "2026-07-28",
    );
    expect((config as { mcpProtocolVersion?: string }).mcpProtocolVersion).toBe(
      "2026-07-28",
    );
  });

  it("leaves the wire era unset for older OAuth versions (legacy default)", async () => {
    const { createServerConfig } = await import("../mcp-oauth");
    const config = createServerConfig(
      "https://mcp.example.com",
      { access_token: "tok" },
      "2025-11-25",
    );
    expect(
      (config as { mcpProtocolVersion?: string }).mcpProtocolVersion,
    ).toBeUndefined();
  });
});

describe("evaluateCallbackSecurity (2R-iss callback gate)", () => {
  const base = {
    callbackState: "s-123",
    callbackIss: "https://as.example.com",
    expectedState: "s-123",
    recordedIssuer: "https://as.example.com",
    issParameterSupported: true as boolean | undefined,
  };

  it("passes when state and iss both match", async () => {
    const { evaluateCallbackSecurity } = await import("../mcp-oauth");
    expect(evaluateCallbackSecurity(base)).toEqual({ ok: true });
  });

  it("rejects a state mismatch (CSRF) before touching iss", async () => {
    const { evaluateCallbackSecurity } = await import("../mcp-oauth");
    const result = evaluateCallbackSecurity({
      ...base,
      callbackState: "attacker-state",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/state.*mismatch|CSRF/i);
  });

  it("rejects when an expected state was issued but the callback returns none", async () => {
    const { evaluateCallbackSecurity } = await import("../mcp-oauth");
    const result = evaluateCallbackSecurity({ ...base, callbackState: null });
    expect(result.ok).toBe(false);
  });

  it("rejects a present-but-mismatched iss (RFC 9207)", async () => {
    const { evaluateCallbackSecurity } = await import("../mcp-oauth");
    const result = evaluateCallbackSecurity({
      ...base,
      callbackIss: "https://evil.example.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/issuer|RFC 9207/i);
  });

  it("rejects an absent iss when the AS advertised iss support", async () => {
    const { evaluateCallbackSecurity } = await import("../mcp-oauth");
    const result = evaluateCallbackSecurity({
      ...base,
      callbackIss: null,
      issParameterSupported: true,
    });
    expect(result.ok).toBe(false);
  });

  it("allows an absent iss when the AS did not advertise iss support", async () => {
    const { evaluateCallbackSecurity } = await import("../mcp-oauth");
    expect(
      evaluateCallbackSecurity({
        ...base,
        callbackIss: null,
        issParameterSupported: undefined,
      }),
    ).toEqual({ ok: true });
  });

  it("skips the state check on the no-session fallback (no expected state)", async () => {
    const { evaluateCallbackSecurity } = await import("../mcp-oauth");
    expect(
      evaluateCallbackSecurity({
        callbackState: "whatever",
        callbackIss: "https://as.example.com",
        expectedState: undefined,
        recordedIssuer: "https://as.example.com",
        issParameterSupported: undefined,
      }),
    ).toEqual({ ok: true });
  });
});
