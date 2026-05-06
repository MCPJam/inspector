import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Hono } from "hono";
import {
  createMockMcpClientManager,
  createTestApp,
  type MockMCPClientManager,
} from "./helpers/index.js";

const PROJECT_ID = "proj_test";
const SERVER_ID = "srv_test";
const SERVER_NAME = "test-server";

function authHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer guest-bearer-test",
  };
}

function mockBatchAuthorizeFetch(
  responseBody: unknown,
  init?: { status?: number }
) {
  const status = init?.status ?? 200;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      return new Response(JSON.stringify(responseBody), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
}

describe("POST /api/mcp/connect", () => {
  let mcpClientManager: MockMCPClientManager;
  let app: Hono;
  const originalConvexUrl = process.env.CONVEX_HTTP_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    mcpClientManager = createMockMcpClientManager();
    app = createTestApp(mcpClientManager, "connect");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalConvexUrl === undefined) delete process.env.CONVEX_HTTP_URL;
    else process.env.CONVEX_HTTP_URL = originalConvexUrl;
  });

  describe("validation", () => {
    it("returns 400 when serverId is missing", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ projectId: PROJECT_ID }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error?: string };
      expect(data.error).toBe("serverId is required");
    });

    it("returns 400 when resolver-path body is missing serverName", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ projectId: PROJECT_ID, serverId: SERVER_ID }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error?: string };
      expect(data.error).toBe("serverName is required with projectId");
    });

    it("returns 401 when projectId set but Authorization bearer is missing", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: PROJECT_ID,
          serverId: SERVER_ID,
          serverName: SERVER_NAME,
        }),
      });

      expect(res.status).toBe(401);
    });

    it("returns 400 when neither projectId nor serverConfig is provided", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ serverId: SERVER_ID }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error?: string };
      expect(data.error).toBe("serverConfig is required");
    });

    it("returns 400 when request body is invalid JSON", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: authHeaders(),
        body: "invalid-json",
      });

      expect(res.status).toBe(400);
    });
  });

  describe("legacy {serverConfig, serverId} body shape (transitional)", () => {
    it("connects with legacy STDIO serverConfig", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: SERVER_ID,
          serverConfig: { command: "node", args: ["server.js"] },
        }),
      });

      expect(res.status).toBe(200);
      expect(mcpClientManager.connectToServer).toHaveBeenCalledWith(
        SERVER_ID,
        { command: "node", args: ["server.js"] }
      );
    });

    it("connects with legacy HTTP serverConfig (URL string)", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: SERVER_ID,
          serverConfig: { url: "http://localhost:3000/mcp" },
        }),
      });

      expect(res.status).toBe(200);
      const callArgs = mcpClientManager.connectToServer.mock.calls[0][1];
      expect(callArgs.url.href).toBe("http://localhost:3000/mcp");
    });
  });

  describe("STDIO connection", () => {
    it("resolves STDIO config from Convex and connects", async () => {
      mockBatchAuthorizeFetch({
        results: {
          [SERVER_ID]: {
            ok: true,
            role: "owner",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "stdio",
              command: "node",
              args: ["server.js"],
              env: { FOO: "bar" },
            },
          },
        },
      });

      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          projectId: PROJECT_ID,
          serverId: SERVER_ID,
          serverName: SERVER_NAME,
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { success: boolean; status: string };
      expect(data.success).toBe(true);
      expect(data.status).toBe("connected");

      // Manager is keyed by display name, not the Convex serverId — the rest
      // of the local API surface (tools list/execute, status) passes display
      // names from the UI.
      expect(mcpClientManager.disconnectServer).toHaveBeenCalledWith(
        SERVER_NAME
      );
      const callArgs = mcpClientManager.connectToServer.mock.calls[0];
      expect(callArgs[0]).toBe(SERVER_NAME);
      expect(callArgs[1]).toMatchObject({
        command: "node",
        args: ["server.js"],
        env: { FOO: "bar" },
      });
    });
  });

  describe("HTTP connection", () => {
    it("resolves HTTP config and attaches OAuth bearer when present", async () => {
      mockBatchAuthorizeFetch({
        results: {
          [SERVER_ID]: {
            ok: true,
            role: "owner",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "http",
              url: "http://localhost:3000/mcp",
              headers: { "X-Foo": "bar" },
              useOAuth: true,
            },
            oauthAccessToken: "oauth-token-123",
          },
        },
      });

      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          projectId: PROJECT_ID,
          serverId: SERVER_ID,
          serverName: SERVER_NAME,
        }),
      });

      expect(res.status).toBe(200);
      const callArgs = mcpClientManager.connectToServer.mock.calls[0];
      expect(callArgs[0]).toBe(SERVER_NAME);
      // Resolver wraps the URL string in a URL object to match the legacy
      // connect path's shape (`new URL(...)`), so assert against `.href`.
      expect(callArgs[1].url).toBeInstanceOf(URL);
      expect(callArgs[1].url.href).toBe("http://localhost:3000/mcp");
      // OAuth bearer merged into requestInit.headers
      expect(callArgs[1].requestInit.headers).toMatchObject({
        "X-Foo": "bar",
        Authorization: "Bearer oauth-token-123",
      });
    });

    it("merges connectionDefaults (project headers, timeout, capabilities) onto resolved config", async () => {
      mockBatchAuthorizeFetch({
        results: {
          [SERVER_ID]: {
            ok: true,
            role: "owner",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "http",
              url: "http://localhost:3000/mcp",
              headers: { "X-Server-Default": "from-convex" },
              useOAuth: false,
            },
          },
        },
      });

      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          projectId: PROJECT_ID,
          serverId: SERVER_ID,
          serverName: SERVER_NAME,
          connectionDefaults: {
            headers: {
              "X-Project-Default": "from-runtime",
              "X-Server-Default": "overridden-by-runtime",
            },
            timeoutMs: 12345,
            clientCapabilities: { sampling: { strategy: "auto" } },
          },
        }),
      });

      expect(res.status).toBe(200);
      const callArgs = mcpClientManager.connectToServer.mock.calls[0];
      const cfg = callArgs[1];
      // Project-default headers overlay Convex-stored server headers; the
      // server-default value is overridden by the runtime overlay.
      expect(cfg.requestInit.headers).toMatchObject({
        "X-Project-Default": "from-runtime",
        "X-Server-Default": "overridden-by-runtime",
      });
      expect(cfg.timeout).toBe(12345);
      expect(cfg.clientCapabilities).toEqual({
        sampling: { strategy: "auto" },
      });
    });

    it("returns 401 when server requires OAuth but no token resolved", async () => {
      mockBatchAuthorizeFetch({
        results: {
          [SERVER_ID]: {
            ok: true,
            role: "owner",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "http",
              url: "http://localhost:3000/mcp",
              headers: {},
              useOAuth: true,
            },
            // no oauthAccessToken
          },
        },
      });

      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ projectId: PROJECT_ID, serverId: SERVER_ID, serverName: SERVER_NAME }),
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as { oauthRequired?: boolean };
      expect(data.oauthRequired).toBe(true);
    });
  });

  describe("authorization failures", () => {
    it("propagates 403 from Convex when actor lacks access", async () => {
      mockBatchAuthorizeFetch({
        results: {
          [SERVER_ID]: {
            ok: false,
            status: 403,
            code: "FORBIDDEN",
            message: "Not a member of project",
          },
        },
      });

      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ projectId: PROJECT_ID, serverId: SERVER_ID, serverName: SERVER_NAME }),
      });

      expect(res.status).toBe(403);
    });

    it("returns 502 when Convex is unreachable", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("network down");
        })
      );

      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ projectId: PROJECT_ID, serverId: SERVER_ID, serverName: SERVER_NAME }),
      });

      expect(res.status).toBe(502);
    });
  });

  describe("connection errors", () => {
    it("returns 500 and removes server when manager.connectToServer throws", async () => {
      mockBatchAuthorizeFetch({
        results: {
          [SERVER_ID]: {
            ok: true,
            role: "owner",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "stdio",
              command: "nonexistent",
              args: [],
              env: {},
            },
          },
        },
      });
      mcpClientManager.connectToServer.mockRejectedValue(
        new Error("Connection refused")
      );

      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ projectId: PROJECT_ID, serverId: SERVER_ID, serverName: SERVER_NAME }),
      });

      expect(res.status).toBe(500);
      const data = (await res.json()) as {
        error?: string;
        details?: string;
      };
      expect(data.error).toContain(
        `Connection failed for server ${SERVER_NAME}`
      );
      expect(data.details).toBe("Connection refused");
      expect(mcpClientManager.removeServer).toHaveBeenCalledWith(SERVER_NAME);
    });

    it("disconnects existing connection before reconnecting", async () => {
      mockBatchAuthorizeFetch({
        results: {
          [SERVER_ID]: {
            ok: true,
            role: "owner",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "stdio",
              command: "node",
              args: [],
              env: {},
            },
          },
        },
      });

      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ projectId: PROJECT_ID, serverId: SERVER_ID, serverName: SERVER_NAME }),
      });

      expect(res.status).toBe(200);
      const disconnectOrder =
        mcpClientManager.disconnectServer.mock.invocationCallOrder[0];
      const connectOrder =
        mcpClientManager.connectToServer.mock.invocationCallOrder[0];
      expect(disconnectOrder).toBeLessThan(connectOrder);
    });
  });
});
