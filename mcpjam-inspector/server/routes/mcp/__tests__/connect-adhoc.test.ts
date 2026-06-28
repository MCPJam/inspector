import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hono } from "hono";
import {
  createMockMcpClientManager,
  createTestApp,
  type MockMCPClientManager,
} from "./helpers/index.js";

const SERVER_ID = "excalidraw";
const SERVER_CONFIG = { url: "https://mcp.excalidraw.com/mcp" };

function headers() {
  return { "Content-Type": "application/json" };
}

describe("POST /api/mcp/connect-adhoc", () => {
  let mcpClientManager: MockMCPClientManager;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createTestApp(mcpClientManager, "connect-adhoc");
  });

  describe("validation", () => {
    it("returns 400 when serverId is missing", async () => {
      const res = await app.request("/api/mcp/connect-adhoc", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ serverConfig: SERVER_CONFIG }),
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe(
        "serverId is required",
      );
      expect(mcpClientManager.connectToServer).not.toHaveBeenCalled();
    });

    it("returns 400 when serverConfig is missing or not an object", async () => {
      for (const serverConfig of [undefined, "nope", ["arr"]]) {
        const res = await app.request("/api/mcp/connect-adhoc", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ serverId: SERVER_ID, serverConfig }),
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error?: string }).error).toBe(
          "serverConfig must be a JSON object",
        );
      }
      expect(mcpClientManager.connectToServer).not.toHaveBeenCalled();
    });
  });

  it("connects the inline config directly (no project lookup) and returns the success envelope", async () => {
    const res = await app.request("/api/mcp/connect-adhoc", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        serverId: SERVER_ID,
        serverConfig: SERVER_CONFIG,
      }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; status: string };
    expect(data.success).toBe(true);
    expect(data.status).toBe("connected");

    // The inline config is handed straight to the manager under serverId —
    // no Convex/project resolution involved.
    expect(mcpClientManager.connectToServer).toHaveBeenCalledWith(
      SERVER_ID,
      SERVER_CONFIG,
    );
    // Pre-connect disconnect is tolerated (idempotent re-connect under same id).
    expect(mcpClientManager.disconnectServer).toHaveBeenCalledWith(SERVER_ID);
  });

  it("cleans up the manager entry and returns 502 when the connection fails", async () => {
    mcpClientManager.connectToServer = vi
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await app.request("/api/mcp/connect-adhoc", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        serverId: SERVER_ID,
        serverConfig: SERVER_CONFIG,
      }),
    });

    expect(res.status).toBe(502);
    const data = (await res.json()) as { success: boolean; error: string };
    expect(data.success).toBe(false);
    expect(data.error).toContain("ECONNREFUSED");
    expect(mcpClientManager.removeServer).toHaveBeenCalledWith(SERVER_ID);
  });
});
