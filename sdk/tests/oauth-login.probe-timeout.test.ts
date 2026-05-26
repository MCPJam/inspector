import { beforeEach, describe, expect, it, vi } from "vitest";

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

describe("runOAuthLogin automatic probe timeout", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("uses the default step timeout when auto-planning probes without one", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authServerUrl = "https://auth.example.com";
    const mockProbeMcpServer = vi.fn().mockResolvedValue({
      oauth: {
        required: true,
        optional: false,
        resourceMetadataUrl,
        resourceMetadata: {
          resource: serverUrl,
          authorization_servers: [authServerUrl],
          scopes_supported: ["openid", "profile", "mcp"],
        },
        authorizationServerMetadataUrl:
          `${authServerUrl}/.well-known/oauth-authorization-server`,
        authorizationServerMetadata: {
          issuer: authServerUrl,
          authorization_endpoint: `${authServerUrl}/authorize`,
          token_endpoint: `${authServerUrl}/token`,
          registration_endpoint: `${authServerUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          client_id_metadata_document_supported: true,
          scopes_supported: ["openid", "profile", "mcp"],
        },
        registrationStrategies: ["preregistered", "dcr", "cimd"],
      },
    });

    vi.doMock("../src/server-probe.js", async () => {
      const actual = await vi.importActual<typeof import("../src/server-probe.js")>(
        "../src/server-probe.js",
      );

      return {
        ...actual,
        probeMcpServer: mockProbeMcpServer,
      };
    });

    const { runOAuthLogin } = await import("../src/oauth-login.js");
    const fetchFn: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);

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

      if (
        url === "https://mcpjam.com/oauth/client-metadata.json" ||
        url.endsWith("/oauth/client-metadata.json")
      ) {
        return jsonResponse({
          client_id: url,
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

    await runOAuthLogin(
      {
        serverUrl,
        auth: { mode: "headless" },
        fetchFn,
      },
      {
        completeHeadlessAuthorization: vi.fn(async () => ({
          code: "auth-code",
        })),
      },
    );

    expect(mockProbeMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        url: serverUrl,
        timeoutMs: 30_000,
      }),
    );
  });
});
