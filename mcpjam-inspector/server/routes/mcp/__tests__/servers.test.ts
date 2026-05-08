import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import servers from "../servers.js";

// Mock rpc-log-bus module
vi.mock("../../../services/rpc-log-bus", () => ({
  rpcLogBus: {
    getBuffer: vi.fn().mockReturnValue([]),
    subscribe: vi.fn().mockReturnValue(() => {}),
  },
}));

// Mock MCPClientManager
const createMockMcpClientManager = (overrides: Record<string, any> = {}) => ({
  getServerSummaries: vi.fn().mockReturnValue([
    {
      id: "server-1",
      status: "connected",
      config: { command: "node", args: ["server1.js"] },
    },
    {
      id: "server-2",
      status: "disconnected",
      config: { url: "http://localhost:3000" },
    },
  ]),
  getConnectionStatus: vi.fn().mockReturnValue("connected"),
  pingServer: vi.fn().mockResolvedValue({ ok: true }),
  getInitializationInfo: vi.fn().mockReturnValue({
    protocolVersion: "2024-11-05",
    capabilities: { tools: {}, resources: {} },
    serverInfo: { name: "test-server", version: "1.0.0" },
  }),
  getClient: vi.fn().mockReturnValue({}),
  disconnectServer: vi.fn().mockResolvedValue(undefined),
  removeServer: vi.fn(),
  connectToServer: vi.fn().mockResolvedValue(undefined),
  listServers: vi.fn().mockReturnValue(["server-1", "server-2"]),
  ...overrides,
});

function createApp(
  mcpClientManager: ReturnType<typeof createMockMcpClientManager>,
) {
  const app = new Hono();

  // Middleware to inject mock mcpClientManager
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = mcpClientManager;
    await next();
  });

  app.route("/api/mcp/servers", servers);
  return app;
}

describe("GET /api/mcp/servers", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  it("returns list of all servers with their status", async () => {
    const res = await app.request("/api/mcp/servers", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.servers).toHaveLength(2);
    expect(data.servers[0]).toEqual({
      id: "server-1",
      name: "server-1",
      status: "connected",
      config: { command: "node", args: ["server1.js"] },
    });
    expect(data.servers[1].status).toBe("disconnected");
  });

  it("returns empty list when no servers configured", async () => {
    mcpClientManager.getServerSummaries.mockReturnValue([]);

    const res = await app.request("/api/mcp/servers", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.servers).toHaveLength(0);
  });

  it("returns 500 when getServerSummaries fails", async () => {
    mcpClientManager.getServerSummaries.mockImplementation(() => {
      throw new Error("Internal error");
    });

    const res = await app.request("/api/mcp/servers", {
      method: "GET",
    });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toBe("Internal error");
  });
});

describe("GET /api/mcp/servers/status/:serverId", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  it("returns connected status for healthy server", async () => {
    mcpClientManager.pingServer.mockResolvedValue({ ok: true });

    const res = await app.request("/api/mcp/servers/status/server-1", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.serverId).toBe("server-1");
    expect(data.status).toBe("connected");
    expect(data.ping).toEqual({ ok: true });

    expect(mcpClientManager.pingServer).toHaveBeenCalledWith("server-1");
  });

  it("returns disconnected status without pinging disconnected server", async () => {
    mcpClientManager.getConnectionStatus.mockReturnValue("disconnected");

    const res = await app.request("/api/mcp/servers/status/server-2", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("disconnected");
    expect(data.ping).toBeNull();
    expect(mcpClientManager.pingServer).not.toHaveBeenCalled();
  });

  it("returns 500 when status check fails", async () => {
    mcpClientManager.pingServer.mockImplementation(() => {
      throw new Error("Ping timeout");
    });

    const res = await app.request("/api/mcp/servers/status/server-1", {
      method: "GET",
    });

    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toBe("Ping timeout");
  });
});

describe("GET /api/mcp/servers/init-info/:serverId", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  it("returns initialization info for connected server", async () => {
    const res = await app.request("/api/mcp/servers/init-info/server-1", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.serverId).toBe("server-1");
    expect(data.initInfo.protocolVersion).toBe("2024-11-05");
    expect(data.initInfo.serverInfo.name).toBe("test-server");
  });

  it("returns 404 when server is not connected", async () => {
    mcpClientManager.getInitializationInfo.mockReturnValue(null);

    const res = await app.request("/api/mcp/servers/init-info/unknown-server", {
      method: "GET",
    });

    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.success).toBe(false);
    expect(data.error).toContain("not connected");
  });
});

describe("DELETE /api/mcp/servers/:serverId", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  it("disconnects and removes server successfully", async () => {
    const res = await app.request("/api/mcp/servers/server-1", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.message).toBe("Disconnected from server: server-1");

    expect(mcpClientManager.disconnectServer).toHaveBeenCalledWith("server-1");
    expect(mcpClientManager.removeServer).toHaveBeenCalledWith("server-1");
  });

  it("handles already disconnected server gracefully", async () => {
    mcpClientManager.getClient.mockReturnValue(null);

    const res = await app.request("/api/mcp/servers/disconnected-server", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Disconnect should not be called for already disconnected server
    expect(mcpClientManager.disconnectServer).not.toHaveBeenCalled();
    expect(mcpClientManager.removeServer).toHaveBeenCalled();
  });

  it("continues removal even if disconnect fails", async () => {
    mcpClientManager.disconnectServer.mockRejectedValue(
      new Error("Already disconnected"),
    );

    const res = await app.request("/api/mcp/servers/server-1", {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // removeServer should still be called
    expect(mcpClientManager.removeServer).toHaveBeenCalledWith("server-1");
  });
});

describe("POST /api/mcp/servers/reconnect", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;
  const originalConvexUrl = process.env.CONVEX_HTTP_URL;
  const RECONNECT_PROJECT_ID = "proj_reconnect";
  const RECONNECT_SERVER_ID = "srv_doc_id";
  const RECONNECT_SERVER_NAME = "server-1";

  function reconnectAuthHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: "Bearer guest-bearer-test",
    };
  }

  function mockBatchAuthorize(responseBody: unknown, init?: { status?: number }) {
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

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalConvexUrl === undefined) delete process.env.CONVEX_HTTP_URL;
    else process.env.CONVEX_HTTP_URL = originalConvexUrl;
  });

  describe("validation", () => {
    it("returns 400 when serverId is missing", async () => {
      const res = await app.request("/api/mcp/servers/reconnect", {
        method: "POST",
        headers: reconnectAuthHeaders(),
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it("returns 400 when resolver-path body is missing serverName", async () => {
      const res = await app.request("/api/mcp/servers/reconnect", {
        method: "POST",
        headers: reconnectAuthHeaders(),
        body: JSON.stringify({
          projectId: RECONNECT_PROJECT_ID,
          serverId: RECONNECT_SERVER_ID,
        }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error?: string };
      expect(data.error).toBe("serverName is required with projectId");
    });

    it("returns 401 when projectId set but Authorization bearer is missing", async () => {
      const res = await app.request("/api/mcp/servers/reconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: RECONNECT_PROJECT_ID,
          serverId: RECONNECT_SERVER_ID,
          serverName: RECONNECT_SERVER_NAME,
        }),
      });

      expect(res.status).toBe(401);
    });

    it("returns 400 when projectId is missing (legacy body shape rejected)", async () => {
      const res = await app.request("/api/mcp/servers/reconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: RECONNECT_SERVER_ID,
          serverConfig: { command: "node", args: ["server.js"] },
        }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error?: string };
      expect(data.error).toBe("projectId is required");
      // Legacy {serverConfig} body must NOT reach the manager.
      expect(mcpClientManager.connectToServer).not.toHaveBeenCalled();
    });
  });

  describe("success cases", () => {
    it("reconnects successfully with STDIO config from Convex", async () => {
      mockBatchAuthorize({
        results: {
          [RECONNECT_SERVER_ID]: {
            ok: true,
            role: "owner",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "stdio",
              command: "node",
              args: ["server.js"],
              env: {},
            },
          },
        },
      });

      const res = await app.request("/api/mcp/servers/reconnect", {
        method: "POST",
        headers: reconnectAuthHeaders(),
        body: JSON.stringify({
          projectId: RECONNECT_PROJECT_ID,
          serverId: RECONNECT_SERVER_ID,
          serverName: RECONNECT_SERVER_NAME,
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        success: boolean;
        status: string;
        initInfo: unknown;
      };
      // Unified envelope: matches /api/mcp/connect and the hosted
      // /api/web/servers/validate shape so the inspector client's
      // `storeInitInfo` takes one path on both surfaces.
      expect(data.success).toBe(true);
      expect(data.status).toBe("connected");
      // initInfo is included in the envelope (null when the manager has no
      // live state). The mock returns a populated object, so it should land.
      expect(data.initInfo).toBeDefined();

      expect(mcpClientManager.disconnectServer).toHaveBeenCalledWith(
        RECONNECT_SERVER_NAME
      );
      const callArgs = mcpClientManager.connectToServer.mock.calls[0];
      expect(callArgs[0]).toBe(RECONNECT_SERVER_NAME);
      expect(callArgs[1]).toMatchObject({
        command: "node",
        args: ["server.js"],
      });
    });

    it("reconnects successfully with HTTP config from Convex", async () => {
      mockBatchAuthorize({
        results: {
          "http-server": {
            ok: true,
            role: "owner",
            accessLevel: "project_member",
            permissions: { chatOnly: false },
            serverConfig: {
              transportType: "http",
              url: "http://localhost:3000/mcp",
              headers: {},
            },
          },
        },
      });

      const res = await app.request("/api/mcp/servers/reconnect", {
        method: "POST",
        headers: reconnectAuthHeaders(),
        body: JSON.stringify({
          projectId: RECONNECT_PROJECT_ID,
          serverId: "http-server",
          serverName: "http-server-display",
        }),
      });

      expect(res.status).toBe(200);
      const callArgs = mcpClientManager.connectToServer.mock.calls[0];
      expect(callArgs[0]).toBe("http-server-display");
      // Resolver wraps the URL string in a URL object to match the legacy
      // connect path's shape (`new URL(...)`), so assert against `.href`.
      expect(callArgs[1].url).toBeInstanceOf(URL);
      expect(callArgs[1].url.href).toBe("http://localhost:3000/mcp");
    });
  });

  describe("reconnection failures", () => {
    it("returns 500 when connectToServer throws", async () => {
      // Pre-dedup, /reconnect also re-checked `getConnectionStatus` after
      // `connectToServer` resolved and reported `success: false` if the
      // status wasn't "connected". The shared `executeLocalServerConnect`
      // helper drops that re-check — `connectToServer` only resolves when
      // the SDK retry policy succeeds in setting `state.client`, so a
      // resolve-but-not-connected race shouldn't happen in practice. The
      // legitimate failure case is `connectToServer` rejecting, which both
      // /connect and /reconnect handle uniformly here.
      mockBatchAuthorize({
        results: {
          [RECONNECT_SERVER_ID]: {
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
      mcpClientManager.connectToServer.mockRejectedValue(
        new Error("Connection refused")
      );

      const res = await app.request("/api/mcp/servers/reconnect", {
        method: "POST",
        headers: reconnectAuthHeaders(),
        body: JSON.stringify({
          projectId: RECONNECT_PROJECT_ID,
          serverId: RECONNECT_SERVER_ID,
          serverName: RECONNECT_SERVER_NAME,
        }),
      });

      expect(res.status).toBe(500);
      const data = (await res.json()) as { success: boolean; error: string };
      expect(data.success).toBe(false);
      // Unified error wraps the underlying message with the server name —
      // matches /api/mcp/connect's pre-existing wording.
      expect(data.error).toContain("Connection refused");
      expect(data.error).toContain(RECONNECT_SERVER_NAME);
    });
  });
});
