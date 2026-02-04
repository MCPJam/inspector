import { describe, it, expect, vi, beforeEach } from "vitest";
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
  pingServer: vi.fn().mockReturnValue("connected"),
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
    const res = await app.request("/api/mcp/servers/status/server-1", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.serverId).toBe("server-1");
    expect(data.status).toBe("connected");

    expect(mcpClientManager.pingServer).toHaveBeenCalledWith("server-1");
  });

  it("returns disconnected status for unhealthy server", async () => {
    mcpClientManager.pingServer.mockReturnValue("disconnected");

    const res = await app.request("/api/mcp/servers/status/server-2", {
      method: "GET",
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("disconnected");
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

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  describe("validation", () => {
    it("returns 400 when serverId is missing", async () => {
      const res = await app.request("/api/mcp/servers/reconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverConfig: { command: "node" } }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("serverId and serverConfig are required");
    });

    it("returns 400 when serverConfig is missing", async () => {
      const res = await app.request("/api/mcp/servers/reconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "server-1" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
    });
  });

  describe("success cases", () => {
    it("reconnects successfully with STDIO config", async () => {
      const res = await app.request("/api/mcp/servers/reconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "server-1",
          serverConfig: { command: "node", args: ["server.js"] },
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.serverId).toBe("server-1");
      expect(data.status).toBe("connected");
      expect(data.message).toContain("Reconnected to server");

      // Verify disconnect was called before connect
      expect(mcpClientManager.disconnectServer).toHaveBeenCalledWith(
        "server-1",
      );
      expect(mcpClientManager.connectToServer).toHaveBeenCalledWith(
        "server-1",
        { command: "node", args: ["server.js"] },
      );
    });

    it("passes URL string as-is", async () => {
      const res = await app.request("/api/mcp/servers/reconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "http-server",
          serverConfig: { url: "http://localhost:3000/mcp" },
        }),
      });

      expect(res.status).toBe(200);
      const callArgs = mcpClientManager.connectToServer.mock.calls[0][1];
      expect(callArgs.url).toBe("http://localhost:3000/mcp");
    });

    it("normalizes URL object with href property to string", async () => {
      const res = await app.request("/api/mcp/servers/reconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "http-server",
          serverConfig: { url: { href: "http://localhost:4000/api" } },
        }),
      });

      expect(res.status).toBe(200);
      const callArgs = mcpClientManager.connectToServer.mock.calls[0][1];
      expect(callArgs.url).toBe("http://localhost:4000/api");
    });
  });

  describe("reconnection failures", () => {
    it("returns error when reconnection fails to establish connection", async () => {
      mcpClientManager.getConnectionStatus.mockReturnValue("failed");

      const res = await app.request("/api/mcp/servers/reconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "server-1",
          serverConfig: { command: "node" },
        }),
      });

      expect(res.status).toBe(200); // Route returns 200 but success: false
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.status).toBe("failed");
      expect(data.error).toContain("failed");
    });

    it("returns 500 when connectToServer throws", async () => {
      mcpClientManager.connectToServer.mockRejectedValue(
        new Error("Connection refused"),
      );

      const res = await app.request("/api/mcp/servers/reconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "server-1",
          serverConfig: { command: "node" },
        }),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Connection refused");
    });
  });
});
