import { DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL } from "../src/oauth/client-identity.js";
import { runOAuthLogin } from "../src/oauth-login.js";

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

describe("runOAuthLogin", () => {
  it("completes a 2025-11-25 CIMD login flow and returns reusable credentials", async () => {
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
          client_name: "MCPJam SDK OAuth Login",
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

      if (
        url === serverUrl &&
        headers.get("Authorization") === "Bearer access-token"
      ) {
        return createMcpInitializeResponse("2025-11-25");
      }

      return jsonResponse({ error: "unexpected" }, 404);
    }) as typeof fetch;

    const result = await runOAuthLogin(
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

    expect(result.completed).toBe(true);
    expect(result.currentStep).toBe("complete");
    expect(result.credentials.accessToken).toBe("access-token");
    expect(result.credentials.refreshToken).toBe("refresh-token");
    expect(result.credentials.clientId).toBe(
      DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
    );
    expect(result.authorizationUrl).toContain(`${authServerUrl}/authorize`);
  });

  it("auto-resolves the login flow from probe metadata before running OAuth", async () => {
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
          client_name: "MCPJam SDK OAuth Login",
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

      if (
        url === serverUrl &&
        headers.get("Authorization") === "Bearer access-token"
      ) {
        return createMcpInitializeResponse("2025-11-25");
      }

      return jsonResponse({ error: "unexpected" }, 404);
    }) as typeof fetch;

    const result = await runOAuthLogin(
      {
        serverUrl,
        auth: { mode: "headless" },
        fetchFn,
      },
      {
        completeHeadlessAuthorization: jest.fn(async () => ({
          code: "auth-code",
        })),
      },
    );

    expect(result.completed).toBe(true);
    expect(result.protocolMode).toBe("auto");
    expect(result.registrationMode).toBe("auto");
    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.registrationStrategy).toBe("cimd");
    expect(result.authorizationPlan.status).toBe("ready");
    expect(result.authorizationPlan.registrationStrategy).toBe("cimd");
  });

  it("returns a structured failure when authorization cannot complete", async () => {
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
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          client_id_metadata_document_supported: true,
        });
      }

      if (url === DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL) {
        return jsonResponse({
          client_id: DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
          client_name: "MCPJam SDK OAuth Login",
        });
      }

      return jsonResponse({ error: "unexpected" }, 404);
    }) as typeof fetch;

    const result = await runOAuthLogin(
      {
        serverUrl,
        protocolVersion: "2025-11-25",
        registrationStrategy: "cimd",
        auth: { mode: "headless" },
        fetchFn,
      },
      {
        completeHeadlessAuthorization: jest.fn(async () => {
          throw new Error("Authorization server served an interactive page");
        }),
      },
    );

    expect(result.completed).toBe(false);
    expect(result.currentStep).toBe("received_authorization_code");
    expect(result.authorizationUrl).toContain(`${authServerUrl}/authorize`);
    expect(result.error?.message).toContain("interactive page");
  });
});
