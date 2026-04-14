import { probeMcpServer } from "../src/server-probe.js";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

describe("probeMcpServer", () => {
  it("reports a ready streamable HTTP server from a raw initialize request", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";

    const fetchFn: typeof fetch = jest.fn(async (input) => {
      const url = String(input);

      if (url === serverUrl) {
        return jsonResponse({
          jsonrpc: "2.0",
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "mock-server", version: "1.0.0" },
            capabilities: { tools: {} },
          },
        });
      }

      if (url === resourceMetadataUrl) {
        return jsonResponse({ error: "missing" }, 404);
      }

      return jsonResponse({ error: "unexpected" }, 404);
    }) as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      fetchFn,
    });

    expect(result.status).toBe("ready");
    expect(result.transport.selected).toBe("streamable-http");
    expect(result.initialize?.protocolVersion).toBe("2025-11-25");
    expect(result.initialize?.serverInfo).toEqual({
      name: "mock-server",
      version: "1.0.0",
    });
    expect(result.oauth.required).toBe(false);
    expect(result.oauth.optional).toBe(false);
  });

  it("detects OAuth metadata and supported registration methods", async () => {
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
        });
      }

      return jsonResponse({ error: "unexpected" }, 404);
    }) as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      protocolVersion: "2025-11-25",
      fetchFn,
    });

    expect(result.status).toBe("oauth_required");
    expect(result.oauth.required).toBe(true);
    expect(result.oauth.resourceMetadataUrl).toBe(resourceMetadataUrl);
    expect(result.oauth.authorizationServerMetadataUrl).toBe(
      `${authServerUrl}/.well-known/oauth-authorization-server`
    );
    expect(result.oauth.registrationStrategies).toEqual([
      "preregistered",
      "dcr",
      "cimd",
    ]);
  });

  it("retries transient probe failures and preserves attempts across retries", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    let initializeCalls = 0;

    const fetchFn: typeof fetch = jest.fn(async (input) => {
      const url = String(input);

      if (url !== serverUrl) {
        return jsonResponse({ error: "unexpected" }, 404);
      }

      initializeCalls += 1;
      if (initializeCalls === 1) {
        throw Object.assign(new Error("connect timeout"), {
          code: "ETIMEDOUT",
        });
      }

      return jsonResponse(
        {
          jsonrpc: "2.0",
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: { name: "mock-server", version: "1.0.0" },
            capabilities: { tools: {} },
          },
        },
        200,
        {}
      );
    }) as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      accessToken: "token",
      fetchFn,
      retryPolicy: {
        retries: 1,
        retryDelayMs: 0,
      },
    });

    expect(result.status).toBe("ready");
    expect(initializeCalls).toBe(2);
    expect(result.transport.attempts).toHaveLength(2);
    expect(result.transport.attempts[0]?.error).toContain("timeout");
  });

  it("does not retry oauth_required responses", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    let initializeCalls = 0;

    const fetchFn: typeof fetch = jest.fn(async (input) => {
      const url = String(input);

      if (url === serverUrl) {
        initializeCalls += 1;
        return new Response(null, { status: 401 });
      }

      return jsonResponse({ error: "missing" }, 404);
    }) as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      fetchFn,
      retryPolicy: {
        retries: 3,
        retryDelayMs: 0,
      },
    });

    expect(result.status).toBe("oauth_required");
    expect(initializeCalls).toBe(1);
  });

  it("does not retry reachable transport mismatch responses", async () => {
    const serverUrl = "https://mcp.example.com/mcp";

    const fetchFn: typeof fetch = jest.fn(async (_input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return jsonResponse({ error: "unsupported" }, 415);
      }

      return jsonResponse({ error: "missing" }, 404, {
        "Content-Type": "application/json",
      });
    }) as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      accessToken: "token",
      fetchFn,
      retryPolicy: {
        retries: 3,
        retryDelayMs: 0,
      },
    });

    expect(result.status).toBe("reachable");
    expect(result.transport.attempts).toHaveLength(2);
  });
});
