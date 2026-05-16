import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";

const authFetchMock = vi.fn();

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

import {
  disconnectAllRuntimeServers,
  reconnectServer,
  testConnection,
} from "../mcp-api";

function readBody(): Record<string, unknown> {
  expect(authFetchMock).toHaveBeenCalledTimes(1);
  const init = authFetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}"));
}

describe("mcp-api local-mode resolver-only path", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
  });

  it("testConnection always sends the resolver body in local mode", async () => {
    const config = {
      url: "http://localhost:8787/mcp",
    } as unknown as MCPServerConfig;

    await testConnection(config, "convex_id_abc123", {
      projectId: "project_xyz",
      serverName: "mcpjam local",
    });

    const body = readBody();
    expect(body.projectId).toBe("project_xyz");
    expect(body.serverId).toBe("convex_id_abc123");
    expect(body.serverName).toBe("mcpjam local");
    expect(body.serverConfig).toBeUndefined();
  });

  it("reconnectServer always sends the resolver body in local mode", async () => {
    const config = {
      url: "http://localhost:8787/mcp",
    } as unknown as MCPServerConfig;

    await reconnectServer("convex_id_abc123", config, {
      projectId: "project_xyz",
      serverName: "mcpjam local",
    });

    const body = readBody();
    expect(body.projectId).toBe("project_xyz");
    expect(body.serverId).toBe("convex_id_abc123");
    expect(body.serverName).toBe("mcpjam local");
    expect(body.serverConfig).toBeUndefined();
  });

  it("testConnection without projectId throws — legacy fallback is gone", async () => {
    const config = {
      url: "http://localhost:8787/mcp",
    } as unknown as MCPServerConfig;

    await expect(
      testConnection(config, "mcpjam local"),
    ).rejects.toThrow(/projectId is required/);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("reconnectServer without projectId throws — legacy fallback is gone", async () => {
    const config = {
      url: "http://localhost:8787/mcp",
    } as unknown as MCPServerConfig;

    await expect(
      reconnectServer("mcpjam local", config),
    ).rejects.toThrow(/projectId is required/);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("disconnectAllRuntimeServers removes every listed local runtime server", async () => {
    authFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            servers: [{ id: "server-1" }, { name: "server-2" }],
          }),
          { status: 200 },
        ),
      )
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ success: true }), { status: 200 }),
        ),
      );

    const result = await disconnectAllRuntimeServers();

    expect(result.success).toBe(true);
    expect(authFetchMock).toHaveBeenNthCalledWith(1, "/api/mcp/servers");
    expect(authFetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/mcp/servers/server-1",
      { method: "DELETE" },
    );
    expect(authFetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/mcp/servers/server-2",
      { method: "DELETE" },
    );
  });
});
