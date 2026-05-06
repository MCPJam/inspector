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

describe("mcp-api local-mode legacy fallback (OAuth bearer present)", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
  });

  it("testConnection sends the display name as serverId when falling back to legacy because of a local OAuth bearer", async () => {
    const config = {
      url: "http://localhost:8787/mcp",
      requestInit: {
        headers: {
          Authorization: "Bearer local-access-token",
        },
      },
    } as unknown as MCPServerConfig;

    await testConnection(config, "convex_id_abc123", {
      projectId: "project_xyz",
      serverName: "mcpjam local",
    });

    const body = readBody();
    // Resolver path is suppressed — the runtime config carries a local
    // bearer that Convex doesn't yet hold.
    expect(body.projectId).toBeUndefined();
    expect(body.serverConfig).toBeDefined();
    // The legacy server-side path uses serverId as the mcpClientManager key;
    // it must be the display name, not the resolved Convex `_id`.
    expect(body.serverId).toBe("mcpjam local");
  });

  it("reconnectServer sends the display name as serverId when falling back to legacy because of a local OAuth bearer", async () => {
    const config = {
      url: "http://localhost:8787/mcp",
      requestInit: {
        headers: {
          Authorization: "Bearer local-access-token",
        },
      },
    } as unknown as MCPServerConfig;

    await reconnectServer("convex_id_abc123", config, {
      projectId: "project_xyz",
      serverName: "mcpjam local",
    });

    const body = readBody();
    expect(body.projectId).toBeUndefined();
    expect(body.serverConfig).toBeDefined();
    expect(body.serverId).toBe("mcpjam local");
  });

  it("testConnection still uses the resolver body when no local OAuth bearer is present", async () => {
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

  it("testConnection without options preserves the legacy 2-arg shape (serverId == display name)", async () => {
    const config = {
      url: "http://localhost:8787/mcp",
    } as unknown as MCPServerConfig;

    await testConnection(config, "mcpjam local");

    const body = readBody();
    expect(body.serverId).toBe("mcpjam local");
    expect(body.serverConfig).toBeDefined();
    expect(body.projectId).toBeUndefined();
  });
});
