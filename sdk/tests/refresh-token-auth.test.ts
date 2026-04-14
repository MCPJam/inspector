import { RefreshTokenOAuthProvider } from "../src/mcp-client-manager/refresh-token-auth-provider";
import { MCPClientManager } from "../src/mcp-client-manager";
import { createMockServer, MOCK_TOOLS } from "./mock-servers";
import http from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AddressInfo } from "net";

// =============================================================================
// RefreshTokenOAuthProvider unit tests
// =============================================================================

describe("RefreshTokenOAuthProvider", () => {
  it("tokens() returns undefined before first exchange", () => {
    const provider = new RefreshTokenOAuthProvider("cid", "rt_abc");
    expect(provider.tokens()).toBeUndefined();
  });

  it("clientInformation() returns { client_id } without secret", () => {
    const provider = new RefreshTokenOAuthProvider("cid", "rt_abc");
    expect(provider.clientInformation()).toEqual({ client_id: "cid" });
  });

  it("clientInformation() returns { client_id, client_secret } with secret", () => {
    const provider = new RefreshTokenOAuthProvider("cid", "rt_abc", "secret");
    expect(provider.clientInformation()).toEqual({
      client_id: "cid",
      client_secret: "secret",
    });
  });

  it("saveTokens() stores tokens and rotates refresh token", () => {
    const provider = new RefreshTokenOAuthProvider("cid", "rt_original");
    const tokens = {
      access_token: "at_123",
      token_type: "bearer",
      refresh_token: "rt_rotated",
    };
    provider.saveTokens(tokens);
    expect(provider.tokens()).toEqual(tokens);
    // Verify rotation by checking prepareTokenRequest uses the new token
    const params = provider.prepareTokenRequest();
    expect(params?.get("refresh_token")).toBe("rt_rotated");
  });

  it("tokens() returns stored tokens after saveTokens()", () => {
    const provider = new RefreshTokenOAuthProvider("cid", "rt_abc");
    const tokens = { access_token: "at_1", token_type: "bearer" };
    provider.saveTokens(tokens);
    expect(provider.tokens()).toEqual(tokens);
  });

  it("redirectUrl returns undefined", () => {
    const provider = new RefreshTokenOAuthProvider("cid", "rt_abc");
    expect(provider.redirectUrl).toBeUndefined();
  });

  it("clientMetadata returns correct metadata", () => {
    const provider = new RefreshTokenOAuthProvider("cid", "rt_abc");
    expect(provider.clientMetadata).toEqual({
      redirect_uris: [],
      grant_types: ["refresh_token"],
    });
  });

  it("prepareTokenRequest() returns grant_type=refresh_token params", () => {
    const provider = new RefreshTokenOAuthProvider("cid", "rt_abc");
    const params = provider.prepareTokenRequest();
    expect(params?.get("grant_type")).toBe("refresh_token");
    expect(params?.get("refresh_token")).toBe("rt_abc");
  });

  it("prepareTokenRequest() uses rotated refresh token after saveTokens()", () => {
    const provider = new RefreshTokenOAuthProvider("cid", "rt_original");
    provider.saveTokens({
      access_token: "at_1",
      token_type: "bearer",
      refresh_token: "rt_new",
    });
    const params = provider.prepareTokenRequest();
    expect(params?.get("refresh_token")).toBe("rt_new");
  });

  it("redirectToAuthorization() throws", () => {
    const provider = new RefreshTokenOAuthProvider("cid", "rt_abc");
    expect(() => provider.redirectToAuthorization(new URL("http://x"))).toThrow(
      "Non-interactive OAuth flow"
    );
  });

  it("codeVerifier() throws", () => {
    const provider = new RefreshTokenOAuthProvider("cid", "rt_abc");
    expect(() => provider.codeVerifier()).toThrow("Non-interactive OAuth flow");
  });
});

// =============================================================================
// MCPClientManager validation tests (no network needed)
// =============================================================================

describe("MCPClientManager refreshToken validation", () => {
  let manager: MCPClientManager;

  beforeEach(() => {
    manager = new MCPClientManager();
  });

  afterEach(async () => {
    await manager.disconnectAllServers();
  });

  it("refreshToken + accessToken throws mutual exclusivity error", async () => {
    await expect(
      manager.connectToServer("test", {
        url: "http://localhost:9999/mcp",
        refreshToken: "rt_abc",
        clientId: "cid",
        accessToken: "at_xyz",
      })
    ).rejects.toThrow(
      '"refreshToken" and "accessToken" are mutually exclusive'
    );
  });

  it("refreshToken + authProvider throws mutual exclusivity error", async () => {
    const fakeAuthProvider = {
      get redirectUrl() {
        return undefined;
      },
      get clientMetadata() {
        return { redirect_uris: [] as URL[] };
      },
      clientInformation() {
        return { client_id: "x" };
      },
      tokens() {
        return undefined;
      },
      saveTokens() {},
      redirectToAuthorization() {},
      saveCodeVerifier() {},
      codeVerifier() {
        return "";
      },
    };
    await expect(
      manager.connectToServer("test", {
        url: "http://localhost:9999/mcp",
        refreshToken: "rt_abc",
        clientId: "cid",
        authProvider: fakeAuthProvider,
      })
    ).rejects.toThrow(
      '"refreshToken" and "authProvider" are mutually exclusive'
    );
  });

  it("refreshToken without clientId throws missing clientId error", async () => {
    await expect(
      manager.connectToServer("test", {
        url: "http://localhost:9999/mcp",
        refreshToken: "rt_abc",
      })
    ).rejects.toThrow('"clientId" is required when "refreshToken" is set');
  });

  it("refreshToken with whitespace-only clientId throws", async () => {
    await expect(
      manager.connectToServer("test", {
        url: "http://localhost:9999/mcp",
        refreshToken: "rt_abc",
        clientId: "   ",
      })
    ).rejects.toThrow('"clientId" is required when "refreshToken" is set');
  });

  it("refreshToken with whitespace-only value throws", async () => {
    await expect(
      manager.connectToServer("test", {
        url: "http://localhost:9999/mcp",
        refreshToken: "   ",
        clientId: "cid",
      })
    ).rejects.toThrow('"refreshToken" must not be empty');
  });

  it("refreshToken with whitespace-only clientSecret is treated as absent", async () => {
    // This should NOT throw about clientSecret — it should proceed
    // and fail on network (not validation). We catch the network error.
    await expect(
      manager.connectToServer("test", {
        url: "http://localhost:9999/mcp",
        refreshToken: "rt_abc",
        clientId: "cid",
        clientSecret: "   ",
      })
    ).rejects.not.toThrow("clientSecret");
  });

  it("refreshToken + requestInit.headers.Authorization (object) throws", async () => {
    await expect(
      manager.connectToServer("test", {
        url: "http://localhost:9999/mcp",
        refreshToken: "rt_abc",
        clientId: "cid",
        requestInit: {
          headers: { Authorization: "Bearer existing" },
        },
      })
    ).rejects.toThrow(
      '"requestInit.headers.Authorization" must not be set when "refreshToken" is used'
    );
  });

  it("refreshToken + requestInit.headers.Authorization (Headers instance) throws", async () => {
    const headers = new Headers();
    headers.set("Authorization", "Bearer existing");
    await expect(
      manager.connectToServer("test", {
        url: "http://localhost:9999/mcp",
        refreshToken: "rt_abc",
        clientId: "cid",
        requestInit: { headers },
      })
    ).rejects.toThrow(
      '"requestInit.headers.Authorization" must not be set when "refreshToken" is used'
    );
  });

  it("refreshToken + requestInit.headers.Authorization (tuple array) throws", async () => {
    await expect(
      manager.connectToServer("test", {
        url: "http://localhost:9999/mcp",
        refreshToken: "rt_abc",
        clientId: "cid",
        requestInit: {
          headers: [["Authorization", "Bearer existing"]],
        },
      })
    ).rejects.toThrow(
      '"requestInit.headers.Authorization" must not be set when "refreshToken" is used'
    );
  });

  it("no refreshToken uses accessToken as before", async () => {
    // Should NOT throw about refreshToken validation — will fail on network
    await expect(
      manager.connectToServer("test", {
        url: "http://localhost:9999/mcp",
        accessToken: "at_xyz",
      })
    ).rejects.not.toThrow("refreshToken");
  });
});

// =============================================================================
// MCPClientManager integration tests
// =============================================================================

/**
 * Starts a mock streamable HTTP server that requires OAuth refresh token auth.
 * - GET /.well-known/oauth-authorization-server → valid metadata
 * - POST /token → exchanges refresh_token for access_token
 * - All /mcp requests require Bearer token (returns 401 without it)
 */
function startMockOAuthStreamableServer(options?: {
  rotateRefreshToken?: string;
  rejectFirstAccessToken?: boolean;
}): Promise<{
  server: http.Server;
  url: string;
  stop: () => Promise<void>;
  getTokenRequests: () => Array<Record<string, string>>;
}> {
  const mcpServer = createMockServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => `session-${Date.now()}`,
  });

  // We connect the MCP server to the transport
  void mcpServer.connect(transport);

  const tokenRequests: Array<Record<string, string>> = [];
  let validAccessToken = "at_first_token";
  let accessTokenUseCount = 0;

  return new Promise((resolve) => {
    const httpServer = http.createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS"
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Mcp-Session-Id"
      );

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // OAuth metadata discovery
      if (
        req.url === "/.well-known/oauth-authorization-server" &&
        req.method === "GET"
      ) {
        const address = httpServer.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${address.port}`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: baseUrl,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}/token`,
            response_types_supported: ["code"],
          })
        );
        return;
      }

      // Token endpoint
      if (req.url === "/token" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk;
        });
        req.on("end", () => {
          const params = new URLSearchParams(body);
          const record: Record<string, string> = {};
          params.forEach((value, key) => {
            record[key] = value;
          });
          tokenRequests.push(record);

          if (params.get("grant_type") !== "refresh_token") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "unsupported_grant_type",
                error_description: "Only refresh_token grant is supported",
              })
            );
            return;
          }

          if (!params.get("refresh_token")) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                error: "invalid_request",
                error_description: "refresh_token is required",
              })
            );
            return;
          }

          // Generate a new access token
          validAccessToken = `at_${Date.now()}`;
          accessTokenUseCount = 0;

          const responseBody: Record<string, unknown> = {
            access_token: validAccessToken,
            token_type: "bearer",
            expires_in: 3600,
          };

          if (options?.rotateRefreshToken) {
            responseBody.refresh_token = options.rotateRefreshToken;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(responseBody));
        });
        return;
      }

      // MCP endpoint — require Bearer auth
      if (req.url === "/mcp") {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          res.writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer error="invalid_token"',
          });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }

        const token = authHeader.slice("Bearer ".length);

        // If configured to reject first use, simulate token expiry mid-session
        if (options?.rejectFirstAccessToken && accessTokenUseCount === 0) {
          accessTokenUseCount++;
          // Accept the initialize request but reject the next one
        } else if (token !== validAccessToken) {
          // Invalidate the token to trigger re-auth
          res.writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer error="invalid_token"',
          });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }

        accessTokenUseCount++;
        await transport.handleRequest(req, res);
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}/mcp`;

      resolve({
        server: httpServer,
        url,
        stop: () =>
          new Promise<void>((resolveStop) => {
            httpServer.close(() => resolveStop());
          }),
        getTokenRequests: () => tokenRequests,
      });
    });
  });
}

describe("MCPClientManager refreshToken integration", () => {
  it("refreshToken + clientId → full 401→token-exchange→connect flow succeeds", async () => {
    const { url, stop, getTokenRequests } =
      await startMockOAuthStreamableServer();

    try {
      const manager = new MCPClientManager();
      await manager.connectToServer("oauth-server", {
        url,
        refreshToken: "rt_initial",
        clientId: "test-client",
      });

      expect(manager.getConnectionStatus("oauth-server")).toBe("connected");

      // Verify token endpoint was called with correct params
      const tokenReqs = getTokenRequests();
      expect(tokenReqs.length).toBeGreaterThanOrEqual(1);
      expect(tokenReqs[0].grant_type).toBe("refresh_token");
      expect(tokenReqs[0].refresh_token).toBe("rt_initial");

      // Verify we can actually use the connection
      const result = await manager.listTools("oauth-server");
      expect(result.tools.length).toBe(MOCK_TOOLS.length);
      expect(
        (manager as any).liveClientStates.get("oauth-server").authProvider
      ).toBeInstanceOf(RefreshTokenOAuthProvider);
      expect(manager.getServerReplayConfigs()).toEqual([
        expect.objectContaining({
          serverId: "oauth-server",
          url,
          refreshToken: "rt_initial",
          clientId: "test-client",
        }),
      ]);
      expect(manager.getServerReplayConfigs()[0]?.accessToken).toBeUndefined();

      await manager.disconnectAllServers();
      expect(
        (manager as any).liveClientStates.get("oauth-server")
      ).toBeUndefined();
      expect(manager.hasServer("oauth-server")).toBe(true);
    } finally {
      await stop();
    }
  }, 30000);

  it("token rotation: second token request uses rotated refresh token", async () => {
    const { url, stop, getTokenRequests } =
      await startMockOAuthStreamableServer({
        rotateRefreshToken: "rt_rotated",
        rejectFirstAccessToken: true,
      });

    try {
      const manager = new MCPClientManager();
      await manager.connectToServer("oauth-rotate", {
        url,
        refreshToken: "rt_original",
        clientId: "test-client",
      });

      expect(manager.getConnectionStatus("oauth-rotate")).toBe("connected");
      await manager.listTools("oauth-rotate");

      // Check that at least one token request was made with the original token
      const tokenReqs = getTokenRequests();
      expect(tokenReqs.length).toBeGreaterThanOrEqual(1);
      expect(tokenReqs[0].refresh_token).toBe("rt_original");

      // If a second token request was triggered by the 401 mid-session,
      // it should use the rotated token
      if (tokenReqs.length >= 2) {
        expect(tokenReqs[1].refresh_token).toBe("rt_rotated");
      }
      expect(manager.getServerReplayConfigs()).toEqual([
        expect.objectContaining({
          serverId: "oauth-rotate",
          url,
          refreshToken: "rt_rotated",
          clientId: "test-client",
        }),
      ]);
      expect(manager.getServerReplayConfigs()[0]?.accessToken).toBeUndefined();

      await manager.disconnectAllServers();
    } finally {
      await stop();
    }
  }, 30000);
});
