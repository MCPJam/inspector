import { OAuthConformanceTest } from "../../src/oauth-conformance/index.js";
import { DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL } from "../../src/oauth/client-identity.js";
import { MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION } from "../../src/oauth/state-machines/shared/initialize.js";
import * as operations from "../../src/operations.js";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

function createMcpInitializeResponse(protocolVersion: string): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    result: {
      protocolVersion,
      serverInfo: { name: "mock-server", version: "1.0.0" },
      capabilities: {},
    },
  });
}

describe("OAuthConformanceTest", () => {
  it("passes the 2025-11-25 CIMD flow with a stubbed headless authorization strategy", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authServerUrl = "https://auth.example.com";

    const fetchFn: typeof fetch = jest.fn(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);

      if (url === serverUrl && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }

      if (url === resourceMetadataUrl) {
        return jsonResponse({
          resource: serverUrl,
          authorization_servers: [authServerUrl],
          scopes_supported: ["openid", "profile", "mcp"],
        });
      }

      if (url === `${authServerUrl}/.well-known/oauth-authorization-server`) {
        return jsonResponse({
          issuer: authServerUrl,
          authorization_endpoint: `${authServerUrl}/authorize`,
          token_endpoint: `${authServerUrl}/token`,
          registration_endpoint: `${authServerUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          client_id_metadata_document_supported: true,
          scopes_supported: ["openid", "profile", "mcp"],
        });
      }

      if (url === DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL) {
        return jsonResponse({
          client_id: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
          client_name: "MCPJam SDK OAuth Conformance",
          redirect_uris: ["http://127.0.0.1:3333/callback"],
        });
      }

      if (url === `${authServerUrl}/token`) {
        return jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      if (url === serverUrl && headers.get("Authorization") === "Bearer access-token") {
        return createMcpInitializeResponse("2025-11-25");
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const test = new OAuthConformanceTest(
      {
        serverUrl,
        protocolVersion: "2025-11-25",
        registrationStrategy: "cimd",
        auth: { mode: "headless" },
        fetchFn,
      },
      {
        completeHeadlessAuthorization: jest.fn(async () => ({
          code: "auth-code",
        })),
      },
    );

    const result = await test.run();

    expect(result.passed).toBe(true);
    expect(result.credentials).toMatchObject({
      clientId: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      expiresIn: 3600,
    });
    expect(result.steps.map((step) => step.step)).toEqual([
      "request_without_token",
      "received_401_unauthorized",
      "request_resource_metadata",
      "received_resource_metadata",
      "request_authorization_server_metadata",
      "received_authorization_server_metadata",
      "cimd_prepare",
      "cimd_fetch_request",
      "cimd_metadata_response",
      "received_client_credentials",
      "generate_pkce_parameters",
      "authorization_request",
      "received_authorization_code",
      "token_request",
      "received_access_token",
      "authenticated_mcp_request",
      "complete",
    ]);
  });

  it("fails early when CIMD is requested but AS does not advertise client_id_metadata_document_supported", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authServerUrl = "https://auth.example.com";

    const fetchFn: typeof fetch = jest.fn(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);

      if (url === serverUrl && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }

      if (url === resourceMetadataUrl) {
        return jsonResponse({
          resource: serverUrl,
          authorization_servers: [authServerUrl],
        });
      }

      if (url === `${authServerUrl}/.well-known/oauth-authorization-server`) {
        return jsonResponse({
          issuer: authServerUrl,
          authorization_endpoint: `${authServerUrl}/authorize`,
          token_endpoint: `${authServerUrl}/token`,
          registration_endpoint: `${authServerUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          // NOTE: client_id_metadata_document_supported is NOT set
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const test = new OAuthConformanceTest(
      {
        serverUrl,
        protocolVersion: "2025-11-25",
        registrationStrategy: "cimd",
        auth: { mode: "headless" },
        fetchFn,
      },
      {
        completeHeadlessAuthorization: jest.fn(),
      },
    );

    const result = await test.run();

    expect(result.passed).toBe(false);
    const failedStep = result.steps.find((step) => step.status === "failed");
    expect(failedStep).toMatchObject({
      status: "failed",
      error: {
        message: expect.stringContaining("client_id_metadata_document_supported"),
      },
    });
    // Should NOT reach cimd_prepare or authorization_request
    const stepNames = result.steps.map((step) => step.step);
    expect(stepNames).toContain("received_authorization_server_metadata");
    expect(stepNames).not.toContain("cimd_prepare");
    expect(stepNames).not.toContain("authorization_request");
  });

  it("captures multiple authorization server metadata attempts for the 2025-03-26 fallback flow", async () => {
    const serverUrl = "https://legacy.example.com/mcp";
    const rootMetadataUrl =
      "https://legacy.example.com/.well-known/oauth-authorization-server";
    const pathMetadataUrl =
      "https://legacy.example.com/.well-known/oauth-authorization-server/mcp";

    const fetchFn: typeof fetch = jest.fn(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);

      if (url === pathMetadataUrl) {
        return jsonResponse({ error: "missing" }, 404);
      }

      if (url === rootMetadataUrl) {
        return jsonResponse({
          issuer: "https://legacy.example.com",
          authorization_endpoint: "https://legacy.example.com/authorize",
          token_endpoint: "https://legacy.example.com/token",
          registration_endpoint: "https://legacy.example.com/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          code_challenge_methods_supported: ["S256"],
        });
      }

      if (url === "https://legacy.example.com/token") {
        return jsonResponse({
          access_token: "legacy-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      if (
        url === serverUrl &&
        headers.get("Authorization") === "Bearer legacy-access-token"
      ) {
        return createMcpInitializeResponse("2024-11-05");
      }

      if (url === serverUrl) {
        return jsonResponse({ error: "not found" }, 404);
      }

      return jsonResponse({ error: "unexpected" }, 404);
    }) as typeof fetch;

    const test = new OAuthConformanceTest(
      {
        serverUrl,
        protocolVersion: "2025-03-26",
        registrationStrategy: "preregistered",
        auth: { mode: "headless" },
        client: {
          preregistered: {
            clientId: "pre-registered-client",
          },
        },
        fetchFn,
      },
      {
        completeHeadlessAuthorization: jest.fn(async () => ({
          code: "legacy-auth-code",
        })),
      },
    );

    const result = await test.run();
    const metadataStep = result.steps.find(
      (step) => step.step === "received_authorization_server_metadata",
    );

    expect(result.passed).toBe(true);
    expect(metadataStep?.httpAttempts).toHaveLength(2);
    expect(metadataStep?.httpAttempts.map((attempt) => attempt.request.url)).toEqual([
      pathMetadataUrl,
      rootMetadataUrl,
    ]);
  });

  it("marks PKCE and authorization steps as skipped for client_credentials", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authServerUrl = "https://auth.example.com";
    const initializeRequests: Array<Record<string, any>> = [];

    const fetchFn: typeof fetch = jest.fn(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);

      if (url === serverUrl && init?.body) {
        initializeRequests.push(JSON.parse(String(init.body)) as Record<string, any>);
      }

      if (url === serverUrl && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }

      if (url === resourceMetadataUrl) {
        return jsonResponse({
          resource: serverUrl,
          authorization_servers: [authServerUrl],
        });
      }

      if (url === `${authServerUrl}/.well-known/oauth-authorization-server`) {
        return jsonResponse({
          issuer: authServerUrl,
          authorization_endpoint: `${authServerUrl}/authorize`,
          token_endpoint: `${authServerUrl}/token`,
          registration_endpoint: `${authServerUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "client_credentials"],
          code_challenge_methods_supported: ["S256"],
        });
      }

      if (url === `${authServerUrl}/register`) {
        return jsonResponse({
          client_id: "registered-client",
          client_secret: "registered-secret",
          token_endpoint_auth_method: "client_secret_post",
        });
      }

      if (url === `${authServerUrl}/token`) {
        const body = String(init?.body ?? "");
        expect(body).toContain("grant_type=client_credentials");
        return jsonResponse({
          access_token: "client-credentials-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      if (
        url === serverUrl &&
        headers.get("Authorization") === "Bearer client-credentials-token"
      ) {
        return createMcpInitializeResponse("2024-11-05");
      }

      return jsonResponse({ error: "unexpected" }, 404);
    }) as typeof fetch;

    const test = new OAuthConformanceTest({
      serverUrl,
      protocolVersion: "2025-06-18",
      registrationStrategy: "dcr",
      auth: {
        mode: "client_credentials",
        clientId: "unused-client-id",
        clientSecret: "unused-client-secret",
      },
      fetchFn,
    });

    const result = await test.run();

    expect(result.passed).toBe(true);
    expect(
      result.steps.find((step) => step.step === "generate_pkce_parameters")
        ?.status,
    ).toBe("skipped");
    expect(
      result.steps.find((step) => step.step === "authorization_request")
        ?.status,
    ).toBe("skipped");
    expect(
      result.steps.find((step) => step.step === "received_authorization_code")
        ?.status,
    ).toBe("skipped");
    expect(
      result.steps.find((step) => step.step === "token_request")?.httpAttempts,
    ).toHaveLength(1);
    expect(initializeRequests).toHaveLength(2);
    for (const requestBody of initializeRequests) {
      expect(requestBody).toMatchObject({
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {
            extensions: {
              [MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION]: {},
            },
          },
        },
      });
    }
  });

  it("fails client_credentials runs when DCR returns a public client", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authServerUrl = "https://auth.example.com";

    const fetchFn: typeof fetch = jest.fn(async (input) => {
      const url = String(input);

      if (url === serverUrl) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }

      if (url === resourceMetadataUrl) {
        return jsonResponse({
          resource: serverUrl,
          authorization_servers: [authServerUrl],
        });
      }

      if (url === `${authServerUrl}/.well-known/oauth-authorization-server`) {
        return jsonResponse({
          issuer: authServerUrl,
          authorization_endpoint: `${authServerUrl}/authorize`,
          token_endpoint: `${authServerUrl}/token`,
          registration_endpoint: `${authServerUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "client_credentials"],
          code_challenge_methods_supported: ["S256"],
        });
      }

      if (url === `${authServerUrl}/register`) {
        return jsonResponse({
          client_id: "registered-client",
          token_endpoint_auth_method: "none",
        });
      }

      return jsonResponse({ error: "unexpected" }, 404);
    }) as typeof fetch;

    const test = new OAuthConformanceTest({
      serverUrl,
      protocolVersion: "2025-06-18",
      registrationStrategy: "dcr",
      auth: {
        mode: "client_credentials",
        clientId: "unused-client-id",
        clientSecret: "unused-client-secret",
      },
      fetchFn,
    });

    const result = await test.run();
    const tokenStep = result.steps.find((step) => step.step === "token_request");

    expect(result.passed).toBe(false);
    expect(tokenStep?.status).toBe("failed");
    expect(tokenStep?.error?.message).toContain("public client");
  });

  it("runs post-auth verification when verification.listTools is true", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authServerUrl = "https://auth.example.com";

    const fetchFn: typeof fetch = jest.fn(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);

      if (url === serverUrl && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }

      if (url === resourceMetadataUrl) {
        return jsonResponse({
          resource: serverUrl,
          authorization_servers: [authServerUrl],
          scopes_supported: ["openid", "mcp"],
        });
      }

      if (url === `${authServerUrl}/.well-known/oauth-authorization-server`) {
        return jsonResponse({
          issuer: authServerUrl,
          authorization_endpoint: `${authServerUrl}/authorize`,
          token_endpoint: `${authServerUrl}/token`,
          registration_endpoint: `${authServerUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          client_id_metadata_document_supported: true,
        });
      }

      if (url === DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL) {
        return jsonResponse({
          client_id: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
          client_name: "MCPJam SDK OAuth Conformance",
          redirect_uris: ["http://127.0.0.1:3333/callback"],
        });
      }

      if (url === `${authServerUrl}/token`) {
        return jsonResponse({
          access_token: "verify-access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      if (
        url === serverUrl &&
        headers.get("Authorization") === "Bearer verify-access-token"
      ) {
        return createMcpInitializeResponse("2025-11-25");
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    // Mock withEphemeralClient to avoid real MCP connection
    const withEphemeralClientSpy = jest
      .spyOn(operations, "withEphemeralClient")
      .mockImplementation(async (_config, fn) => {
        // Simulate a successful manager callback
        const mockManager = {
          listTools: jest.fn().mockResolvedValue({
            tools: [
              { name: "tool_a", inputSchema: { type: "object" } },
              { name: "tool_b", inputSchema: { type: "object" } },
            ],
          }),
        } as any;
        return fn(mockManager, "__conformance_verify__");
      });

    try {
      const test = new OAuthConformanceTest(
        {
          serverUrl,
          protocolVersion: "2025-11-25",
          registrationStrategy: "cimd",
          auth: { mode: "headless" },
          fetchFn,
          verification: { listTools: true },
        },
        {
          completeHeadlessAuthorization: jest.fn(async () => ({
            code: "auth-code",
          })),
        },
      );

      const result = await test.run();

      expect(result.passed).toBe(true);
      expect(result.verification).toBeDefined();
      expect(result.verification!.listTools).toEqual({
        passed: true,
        toolCount: 2,
        durationMs: expect.any(Number),
      });
      expect(result.steps.map((s) => s.step)).toContain("verify_list_tools");
      expect(
        result.steps.find((s) => s.step === "verify_list_tools")?.status,
      ).toBe("passed");

      // Verify withEphemeralClient was called with the access token
      expect(withEphemeralClientSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          url: serverUrl,
          accessToken: "verify-access-token",
        }),
        expect.any(Function),
        expect.any(Object),
      );
    } finally {
      withEphemeralClientSpy.mockRestore();
    }
  });

  it("skips verification when OAuth itself fails", async () => {
    const serverUrl = "https://mcp.example.com/mcp";

    const fetchFn: typeof fetch = jest.fn(async () =>
      jsonResponse({ error: "server error" }, 500),
    ) as typeof fetch;

    const test = new OAuthConformanceTest({
      serverUrl,
      protocolVersion: "2025-06-18",
      registrationStrategy: "dcr",
      auth: { mode: "headless" },
      fetchFn,
      verification: { listTools: true },
    });

    const result = await test.run();

    expect(result.passed).toBe(false);
    expect(result.verification).toBeUndefined();
    expect(result.steps.map((s) => s.step)).not.toContain("verify_list_tools");
  });

  it("runs OAuth negative and token-format checks after a successful flow", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const redirectUrl = "http://127.0.0.1:3333/callback";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authServerUrl = "https://auth.example.com";
    const tokenBodies: string[] = [];

    const fetchFn: typeof fetch = jest.fn(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);

      if (url === serverUrl && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }

      if (url === resourceMetadataUrl) {
        return jsonResponse({
          resource: serverUrl,
          authorization_servers: [authServerUrl],
          scopes_supported: ["openid", "mcp"],
        });
      }

      if (url === `${authServerUrl}/.well-known/oauth-authorization-server`) {
        return jsonResponse({
          issuer: authServerUrl,
          authorization_endpoint: `${authServerUrl}/authorize`,
          token_endpoint: `${authServerUrl}/token`,
          registration_endpoint: `${authServerUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          client_id_metadata_document_supported: true,
        });
      }

      if (url === `${authServerUrl}/register`) {
        return jsonResponse({ error: "invalid_redirect_uri" }, 400);
      }

      if (url.startsWith(`${authServerUrl}/authorize?`)) {
        const redirectUri = new URL(url).searchParams.get("redirect_uri");
        if (redirectUri?.includes("invalid=1")) {
          return jsonResponse(
            {
              error: "invalid_request",
              error_description: "redirect_uri mismatch",
            },
            400,
          );
        }
      }

      if (url === DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL) {
        return jsonResponse({
          client_id: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
          client_name: "MCPJam SDK OAuth Conformance",
          redirect_uris: [redirectUrl],
        });
      }

      if (url === `${authServerUrl}/token`) {
        const body = String(init?.body ?? "");
        tokenBodies.push(body);

        if (body.includes("client_id=invalid-client-id")) {
          return jsonResponse({ error: "invalid_client" }, 401);
        }

        if (
          body.includes(
            "redirect_uri=http%3A%2F%2F127.0.0.1%3A3333%2Fcallback%3Finvalid%3D1",
          )
        ) {
          return jsonResponse({ error: "invalid_grant" }, 400);
        }

        return jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      if (
        url === serverUrl &&
        headers.get("Authorization") === "Bearer invalid-access-token"
      ) {
        return jsonResponse({ error: "invalid_token" }, 401);
      }

      if (url === serverUrl && headers.get("Authorization") === "Bearer access-token") {
        return createMcpInitializeResponse("2025-11-25");
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const test = new OAuthConformanceTest(
      {
        serverUrl,
        protocolVersion: "2025-11-25",
        registrationStrategy: "cimd",
        auth: { mode: "headless" },
        fetchFn,
        redirectUrl,
        oauthConformanceChecks: true,
      },
      {
        completeHeadlessAuthorization: jest.fn(async () => ({
          code: "auth-code",
        })),
      },
    );

    const result = await test.run();
    const statuses = Object.fromEntries(
      result.steps.map((step) => [step.step, step.status]),
    );

    expect(result.passed).toBe(true);
    expect(tokenBodies).toHaveLength(3);
    expect(statuses.oauth_dcr_http_redirect_uri).toBe("passed");
    expect(statuses.oauth_invalid_client).toBe("passed");
    expect(statuses.oauth_invalid_authorize_redirect).toBe("passed");
    expect(statuses.oauth_invalid_token).toBe("passed");
    expect(statuses.oauth_invalid_redirect).toBe("skipped");
    expect(statuses.oauth_token_format).toBe("passed");
  });

  it("prefers the challenged scope from WWW-Authenticate over scopes_supported", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authServerUrl = "https://auth.example.com";
    const completeHeadlessAuthorization = jest.fn(
      async ({ authorizationUrl }: { authorizationUrl: string }) => {
        const url = new URL(authorizationUrl);
        expect(url.searchParams.get("scope")).toBe("files:read files:write");
        return { code: "auth-code" };
      },
    );

    const fetchFn: typeof fetch = jest.fn(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);

      if (url === serverUrl && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}", scope="files:read files:write"`,
          },
        });
      }

      if (url === resourceMetadataUrl) {
        return jsonResponse({
          resource: serverUrl,
          authorization_servers: [authServerUrl],
          scopes_supported: ["openid", "profile", "mcp"],
        });
      }

      if (url === `${authServerUrl}/.well-known/oauth-authorization-server`) {
        return jsonResponse({
          issuer: authServerUrl,
          authorization_endpoint: `${authServerUrl}/authorize`,
          token_endpoint: `${authServerUrl}/token`,
          registration_endpoint: `${authServerUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          client_id_metadata_document_supported: true,
          scopes_supported: ["openid", "profile", "mcp"],
        });
      }

      if (url === DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL) {
        return jsonResponse({
          client_id: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
          client_name: "MCPJam SDK OAuth Conformance",
          redirect_uris: ["http://127.0.0.1:3333/callback"],
        });
      }

      if (url === `${authServerUrl}/token`) {
        return jsonResponse({
          access_token: "scoped-access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      if (
        url === serverUrl &&
        headers.get("Authorization") === "Bearer scoped-access-token"
      ) {
        return createMcpInitializeResponse("2025-11-25");
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const test = new OAuthConformanceTest(
      {
        serverUrl,
        protocolVersion: "2025-11-25",
        registrationStrategy: "cimd",
        auth: { mode: "headless" },
        fetchFn,
      },
      {
        completeHeadlessAuthorization,
      },
    );

    const result = await test.run();

    expect(result.passed).toBe(true);
    expect(completeHeadlessAuthorization).toHaveBeenCalledTimes(1);
  });

  it("fails strict conformance when DCR metadata omits registration_endpoint", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authServerUrl = "https://auth.example.com";

    const fetchFn: typeof fetch = jest.fn(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);

      if (url === serverUrl && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }

      if (url === resourceMetadataUrl) {
        return jsonResponse({
          resource: serverUrl,
          authorization_servers: [authServerUrl],
        });
      }

      if (url === `${authServerUrl}/.well-known/oauth-authorization-server`) {
        return jsonResponse({
          issuer: authServerUrl,
          authorization_endpoint: `${authServerUrl}/authorize`,
          token_endpoint: `${authServerUrl}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const test = new OAuthConformanceTest({
      serverUrl,
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      auth: { mode: "headless" },
      fetchFn,
    });

    const result = await test.run();
    const failedStep = result.steps.find((step) => step.status === "failed");

    expect(result.passed).toBe(false);
    expect(failedStep).toMatchObject({
      status: "failed",
      error: {
        message: expect.stringContaining("registration_endpoint"),
      },
    });
  });

  it("fails 2025-11-25 conformance when S256 is not advertised", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authServerUrl = "https://auth.example.com";

    const fetchFn: typeof fetch = jest.fn(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);

      if (url === serverUrl && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }

      if (url === resourceMetadataUrl) {
        return jsonResponse({
          resource: serverUrl,
          authorization_servers: [authServerUrl],
        });
      }

      if (url === `${authServerUrl}/.well-known/oauth-authorization-server`) {
        return jsonResponse({
          issuer: authServerUrl,
          authorization_endpoint: `${authServerUrl}/authorize`,
          token_endpoint: `${authServerUrl}/token`,
          registration_endpoint: `${authServerUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["plain"],
          client_id_metadata_document_supported: true,
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const test = new OAuthConformanceTest({
      serverUrl,
      protocolVersion: "2025-11-25",
      registrationStrategy: "cimd",
      auth: { mode: "headless" },
      fetchFn,
    });

    const result = await test.run();
    const failedStep = result.steps.find((step) => step.status === "failed");

    expect(result.passed).toBe(false);
    expect(failedStep).toMatchObject({
      status: "failed",
      error: {
        message: expect.stringContaining("advertise S256"),
      },
    });
  });

  it("fails conformance when DCR accepts a non-loopback http redirect URI", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const redirectUrl = "http://127.0.0.1:3333/callback";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authServerUrl = "https://auth.example.com";

    const fetchFn: typeof fetch = jest.fn(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);

      if (url === serverUrl && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        });
      }

      if (url === resourceMetadataUrl) {
        return jsonResponse({
          resource: serverUrl,
          authorization_servers: [authServerUrl],
        });
      }

      if (url === `${authServerUrl}/.well-known/oauth-authorization-server`) {
        return jsonResponse({
          issuer: authServerUrl,
          authorization_endpoint: `${authServerUrl}/authorize`,
          token_endpoint: `${authServerUrl}/token`,
          registration_endpoint: `${authServerUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
        });
      }

      if (url === `${authServerUrl}/register`) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          redirect_uris?: string[];
        };

        if (body.redirect_uris?.[0] === "http://evil.example/callback") {
          return jsonResponse(
            {
              client_id: "evil-client",
              redirect_uris: body.redirect_uris,
            },
            201,
          );
        }

        return jsonResponse(
          {
            client_id: "legit-client",
            redirect_uris: body.redirect_uris,
          },
          201,
        );
      }

      if (url === `${authServerUrl}/token`) {
        const body = String(init?.body ?? "");

        if (body.includes("client_id=invalid-client-id")) {
          return jsonResponse({ error: "invalid_client" }, 401);
        }

        if (
          body.includes(
            "redirect_uri=http%3A%2F%2F127.0.0.1%3A3333%2Fcallback%3Finvalid%3D1",
          )
        ) {
          return jsonResponse(
            {
              error: "invalid_request",
              error_description: "redirect_uri mismatch",
            },
            400,
          );
        }

        return jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      if (url === serverUrl && headers.get("Authorization") === "Bearer access-token") {
        return createMcpInitializeResponse("2025-11-25");
      }

      return jsonResponse({ error: "not found" }, 404);
    }) as typeof fetch;

    const test = new OAuthConformanceTest(
      {
        serverUrl,
        protocolVersion: "2025-11-25",
        registrationStrategy: "dcr",
        auth: { mode: "headless" },
        fetchFn,
        redirectUrl,
        oauthConformanceChecks: true,
        verification: { listTools: true },
      },
      {
        completeHeadlessAuthorization: jest.fn(async () => ({
          code: "auth-code",
        })),
      },
    );

    const result = await test.run();
    const dcrCheck = result.steps.find(
      (step) => step.step === "oauth_dcr_http_redirect_uri",
    );

    expect(result.passed).toBe(false);
    expect(dcrCheck).toMatchObject({
      status: "failed",
      error: {
        details: expect.objectContaining({
          redirectUri: "http://evil.example/callback",
          clientId: "evil-client",
        }),
      },
    });
    expect(result.verification).toBeUndefined();
    expect(result.steps.map((step) => step.step)).not.toContain("verify_list_tools");
  });
});
