import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hono } from "hono";
import {
  createMockMcpClientManager,
  createTestApp,
  type MockMCPClientManager,
} from "./helpers/index.js";

describe("POST /api/mcp/connect", () => {
  let mcpClientManager: MockMCPClientManager;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createTestApp(mcpClientManager, "connect");
  });

  describe("validation", () => {
    it("returns 400 when serverConfig is missing", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("serverConfig is required");
    });

    it("returns 400 when serverId is missing", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverConfig: { command: "node" } }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("serverId is required");
    });

    it("returns 400 when request body is invalid JSON", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid-json",
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Failed to parse request body");
    });
  });

  describe("STDIO connection", () => {
    it("connects successfully with command config", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          serverConfig: {
            command: "node",
            args: ["server.js"],
          },
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("connected");

      // Verify MCPClientManager was called
      expect(mcpClientManager.disconnectServer).toHaveBeenCalledWith("test-server");
      expect(mcpClientManager.connectToServer).toHaveBeenCalledWith(
        "test-server",
        { command: "node", args: ["server.js"] }
      );
    });
  });

  describe("HTTP/SSE connection", () => {
    it("connects successfully with URL string config", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "http-server",
          serverConfig: {
            url: "http://localhost:3000/mcp",
          },
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe("connected");

      // Verify URL was converted to URL object
      expect(mcpClientManager.connectToServer).toHaveBeenCalledWith(
        "http-server",
        expect.objectContaining({
          url: expect.any(URL),
        })
      );

      const callArgs = mcpClientManager.connectToServer.mock.calls[0][1];
      expect(callArgs.url.href).toBe("http://localhost:3000/mcp");
    });

    it("connects successfully with URL object config (href)", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "http-server",
          serverConfig: {
            url: { href: "http://localhost:4000/api" },
          },
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      const callArgs = mcpClientManager.connectToServer.mock.calls[0][1];
      expect(callArgs.url.href).toBe("http://localhost:4000/api");
    });
  });

  describe("connection errors", () => {
    it("returns 500 when connection fails", async () => {
      mcpClientManager.connectToServer.mockRejectedValue(
        new Error("Connection refused")
      );

      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "failing-server",
          serverConfig: { command: "nonexistent" },
        }),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain("Connection failed for server failing-server");
      expect(data.details).toBe("Connection refused");
    });

    it("disconnects existing connection before reconnecting", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "existing-server",
          serverConfig: { command: "node" },
        }),
      });

      expect(res.status).toBe(200);

      // Verify disconnect was called before connect
      const disconnectOrder = mcpClientManager.disconnectServer.mock.invocationCallOrder[0];
      const connectOrder = mcpClientManager.connectToServer.mock.invocationCallOrder[0];
      expect(disconnectOrder).toBeLessThan(connectOrder);
    });
  });

  describe("edge cases", () => {
    it("handles empty serverConfig gracefully", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test",
          serverConfig: {},
        }),
      });

      expect(res.status).toBe(200);
      expect(mcpClientManager.connectToServer).toHaveBeenCalledWith(
        "test",
        {}
      );
    });

    it("handles serverConfig with undefined url", async () => {
      const res = await app.request("/api/mcp/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test",
          serverConfig: { url: undefined, command: "node" },
        }),
      });

      expect(res.status).toBe(200);
    });
  });
});
