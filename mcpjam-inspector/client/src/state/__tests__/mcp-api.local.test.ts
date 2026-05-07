import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";

const authFetchMock = vi.fn();

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
}));

import { reconnectServer, testConnection } from "../mcp-api";

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
});
