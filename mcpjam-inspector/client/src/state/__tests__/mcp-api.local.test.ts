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

// Post-Slice-2 (`MCPOAuthProvider.saveTokens` pushes through
// `/api/web/oauth/import-tokens`), Convex always has the OAuth tokens by the
// time `testConnection`/`reconnectServer` fires, so the resolver path no
// longer needs to bypass itself when the runtime config carries a local
// bearer header. These tests pin that the resolver is always used when
// projectId is provided, regardless of an Authorization header on the
// runtime config.
describe("mcp-api local-mode resolver vs legacy paths", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );
  });

  it("testConnection takes the resolver path when projectId is set, even with a local OAuth bearer in serverConfig", async () => {
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
    expect(body.projectId).toBe("project_xyz");
    expect(body.serverId).toBe("convex_id_abc123");
    expect(body.serverName).toBe("mcpjam local");
    expect(body.serverConfig).toBeUndefined();
  });

  it("reconnectServer takes the resolver path when projectId is set, even with a local OAuth bearer in serverConfig", async () => {
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
    expect(body.projectId).toBe("project_xyz");
    expect(body.serverId).toBe("convex_id_abc123");
    expect(body.serverName).toBe("mcpjam local");
    expect(body.serverConfig).toBeUndefined();
  });

  it("testConnection takes the resolver path when projectId is set and config carries no local bearer", async () => {
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
