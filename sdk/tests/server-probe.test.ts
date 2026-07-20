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

  it("uses modern path-insertion AS discovery (no root fallback) for 2026-07-28 + path issuer", async () => {
    // Regression guard: 2026-07-28 must share the 2025-11-25 AS-metadata
    // discovery (path insertion, NO root fallback for path-containing issuers).
    // Before the fix, 2026 fell through to the older branch that adds a root
    // fallback URL the spec forbids.
    //
    // The metadata succeeds ONLY on a modern-branch-exclusive candidate (the
    // OIDC path-APPENDING URL) and 404s the shared path-insertion URL, so the
    // loop must advance past the first candidate to where the two branches
    // diverge: the modern branch tries path-appending next, the old branch
    // requests the root fallback. This is what makes the guard actually fail
    // on the un-fixed code — succeeding on path-insertion (candidate #1 in
    // BOTH branches) would pass either way and guard nothing.
    const serverUrl = "https://mcp.example.com/mcp";
    const resourceMetadataUrl =
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp";
    const authServerUrl = "https://auth.example.com/tenant1"; // path-containing
    const pathInsertionUrl =
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1";
    // Modern-branch-only candidate (OIDC path appending); absent from the old
    // branch, which would reach the root fallback instead.
    const pathAppendOidcUrl =
      "https://auth.example.com/tenant1/.well-known/openid-configuration";
    const rootFallbackUrl =
      "https://auth.example.com/.well-known/oauth-authorization-server";
    const requested: string[] = [];

    const fetchFn: typeof fetch = jest.fn(async (input) => {
      const url = String(input);
      requested.push(url);
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
      if (url === pathAppendOidcUrl) {
        return jsonResponse({
          issuer: authServerUrl,
          authorization_endpoint: `${authServerUrl}/authorize`,
          token_endpoint: `${authServerUrl}/token`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      // Everything else (including path-insertion) 404s, forcing the loop to
      // advance to the branch-divergence point.
      return jsonResponse({ error: "unexpected" }, 404);
    }) as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      protocolVersion: "2026-07-28",
      fetchFn,
    });

    // Resolved via the modern path-appending candidate...
    expect(result.oauth.authorizationServerMetadataUrl).toBe(pathAppendOidcUrl);
    // ...and the shared path-insertion candidate was tried first (proving we
    // advanced past candidate #1)...
    expect(requested).toContain(pathInsertionUrl);
    // ...but the root fallback (old-branch candidate #2) was NEVER requested.
    // On the un-fixed code this assertion fails.
    expect(requested).not.toContain(rootFallbackUrl);
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

  it("does not retry deterministic probe failures", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const fetchFn: typeof fetch = jest.fn(async () => {
      throw new TypeError("malformed request");
    }) as typeof fetch;

    const result = await probeMcpServer({
      url: serverUrl,
      fetchFn,
      retryPolicy: {
        retries: 3,
        retryDelayMs: 0,
      },
    });

    expect(result.status).toBe("error");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.transport.attempts).toHaveLength(1);
  });
});
