import { OAuthConformanceTest } from "../../src/oauth-conformance/index.js";
import { DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL } from "../../src/oauth/client-identity.js";

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
});
