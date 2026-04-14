import { OAuthConformanceSuite } from "../../src/oauth-conformance/suite.js";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
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

/**
 * Builds a mock fetch that supports the full OAuth flow for client_credentials.
 * Uses client_credentials to avoid needing headless authorization mocking,
 * since the suite creates OAuthConformanceTest instances internally.
 */
function buildMockFetch(
  serverUrl: string,
  authServerUrl: string,
): typeof fetch {
  const origin = new URL(serverUrl).origin;
  const pathname = new URL(serverUrl).pathname;
  const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource${pathname}`;

  return jest.fn(async (input, init) => {
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
        grant_types_supported: [
          "authorization_code",
          "client_credentials",
          "refresh_token",
        ],
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
      return jsonResponse({
        access_token: "suite-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    }

    if (
      url === serverUrl &&
      headers.get("Authorization") === "Bearer suite-access-token"
    ) {
      return createMcpInitializeResponse("2025-06-18");
    }

    return jsonResponse({ error: "not found" }, 404);
  }) as typeof fetch;
}

describe("OAuthConformanceSuite", () => {
  it("throws when serverUrl is missing", () => {
    expect(
      () =>
        new OAuthConformanceSuite({
          serverUrl: "",
          flows: [
            {
              protocolVersion: "2025-11-25",
              registrationStrategy: "dcr",
            },
          ],
        }),
    ).toThrow("requires serverUrl");
  });

  it("throws when flows array is empty", () => {
    expect(
      () =>
        new OAuthConformanceSuite({
          serverUrl: "https://mcp.example.com/mcp",
          flows: [],
        }),
    ).toThrow("at least one flow");
  });

  it("runs multiple client_credentials flows and aggregates results", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const authServerUrl = "https://auth.example.com";
    const fetchFn = buildMockFetch(serverUrl, authServerUrl);

    const suite = new OAuthConformanceSuite({
      name: "Test Suite",
      serverUrl,
      defaults: {
        fetchFn,
      },
      flows: [
        {
          label: "DCR + client_credentials",
          protocolVersion: "2025-06-18",
          registrationStrategy: "dcr",
          auth: {
            mode: "client_credentials",
            clientId: "unused",
            clientSecret: "unused",
          },
        },
        {
          label: "Preregistered + client_credentials",
          protocolVersion: "2025-06-18",
          registrationStrategy: "preregistered",
          client: {
            preregistered: {
              clientId: "pre-client",
              clientSecret: "pre-secret",
            },
          },
          auth: {
            mode: "client_credentials",
            clientId: "pre-client",
            clientSecret: "pre-secret",
          },
        },
      ],
    });

    const result = await suite.run();

    expect(result.name).toBe("Test Suite");
    expect(result.serverUrl).toBe(serverUrl);
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].label).toBe("DCR + client_credentials");
    expect(result.results[1].label).toBe("Preregistered + client_credentials");
    expect(result.summary).toContain("All 2 flows passed");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports overall failure when any flow fails", async () => {
    const serverUrl = "https://mcp.example.com/mcp";

    const fetchFn: typeof fetch = jest.fn(async () => {
      return jsonResponse({ error: "server down" }, 500);
    }) as typeof fetch;

    const suite = new OAuthConformanceSuite({
      serverUrl,
      flows: [
        {
          protocolVersion: "2025-06-18",
          registrationStrategy: "dcr",
          auth: { mode: "headless" },
          fetchFn,
        },
      ],
    });

    const result = await suite.run();

    expect(result.passed).toBe(false);
    expect(result.summary).toContain("0/1 flows passed");
  });

  it("auto-generates labels when not provided", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const fetchFn: typeof fetch = jest.fn(async () =>
      jsonResponse({ error: "not found" }, 500),
    ) as typeof fetch;

    const suite = new OAuthConformanceSuite({
      serverUrl,
      flows: [
        {
          protocolVersion: "2025-11-25",
          registrationStrategy: "cimd",
          auth: { mode: "headless" },
          fetchFn,
        },
      ],
    });

    const result = await suite.run();
    expect(result.results[0].label).toBe("2025-11-25/cimd/headless");
  });

  it("merges defaults with per-flow overrides", async () => {
    const serverUrl = "https://mcp.example.com/mcp";
    const defaultFetch: typeof fetch = jest.fn(async () =>
      jsonResponse({ error: "default" }, 500),
    ) as typeof fetch;
    const overrideFetch: typeof fetch = jest.fn(async () =>
      jsonResponse({ error: "override" }, 500),
    ) as typeof fetch;

    const suite = new OAuthConformanceSuite({
      serverUrl,
      defaults: {
        auth: { mode: "headless" },
        fetchFn: defaultFetch,
        stepTimeout: 5000,
      },
      flows: [
        {
          label: "uses defaults",
          protocolVersion: "2025-06-18",
          registrationStrategy: "dcr",
        },
        {
          label: "uses override fetch",
          protocolVersion: "2025-06-18",
          registrationStrategy: "dcr",
          fetchFn: overrideFetch,
        },
      ],
    });

    await suite.run();

    expect(defaultFetch).toHaveBeenCalled();
    expect(overrideFetch).toHaveBeenCalled();
  });
});
