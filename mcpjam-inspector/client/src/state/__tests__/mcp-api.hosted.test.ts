import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";

const validateHostedServerMock = vi.fn();

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/apis/web/servers-api", () => ({
  validateHostedServer: (...args: unknown[]) =>
    validateHostedServerMock(...args),
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

import { BootstrapNotReadyError } from "@/lib/app-ready";
import { reconnectServer, testConnection } from "../mcp-api";

describe("mcp-api hosted-mode reconnect hardening", () => {
  beforeEach(() => {
    vi.useRealTimers();
    validateHostedServerMock.mockReset();
  });

  it("normalizes hosted project timing errors for testConnection", async () => {
    validateHostedServerMock.mockRejectedValueOnce(
      new BootstrapNotReadyError("provisioning-project")
    );

    const result = await testConnection({} as MCPServerConfig, "server-1");

    expect(result).toEqual({
      success: false,
      error: "Hosted project is still loading. Please try again in a moment.",
    });
  });

  it("normalizes hosted server lookup errors for reconnectServer", async () => {
    validateHostedServerMock.mockRejectedValueOnce(
      new Error('Hosted server not found for "server-2"')
    );

    const result = await reconnectServer("server-2", {} as MCPServerConfig);

    expect(result).toEqual({
      success: false,
      error: "Hosted server metadata is still syncing. Please retry.",
    });
  });

  it("returns generic hosted validation errors without throwing", async () => {
    validateHostedServerMock.mockRejectedValueOnce(new Error("Boom"));

    const result = await reconnectServer("server-3", {} as MCPServerConfig);

    expect(result).toEqual({
      success: false,
      error: "Boom",
    });
  });

  it("times out hung hosted validation requests", async () => {
    vi.useFakeTimers();
    validateHostedServerMock.mockReturnValueOnce(new Promise(() => {}));

    const resultPromise = testConnection(
      {} as MCPServerConfig,
      "server-timeout"
    );

    await vi.advanceTimersByTimeAsync(20_000);

    await expect(resultPromise).resolves.toEqual({
      success: false,
      error:
        "Connection attempt timed out after 20 seconds. The server may not exist or is not responding.",
    });
  });

  it("passes through successful hosted validation and OAuth token extraction", async () => {
    validateHostedServerMock.mockResolvedValueOnce({
      success: true,
      status: "ok",
    });

    const config = {
      requestInit: {
        headers: {
          Authorization: "Bearer access-token",
        },
      },
    } as MCPServerConfig;

    const result = await testConnection(config, "server-4");

    expect(validateHostedServerMock).toHaveBeenCalledWith(
      "server-4",
      "access-token",
      undefined,
      undefined
    );
    expect(result).toEqual({ success: true, status: "ok" });
  });

  it("uses explicit project/server context for freshly created hosted servers", async () => {
    validateHostedServerMock.mockResolvedValueOnce({
      success: true,
      status: "ok",
    });

    const config = {
      url: "https://mcp.excalidraw.com/mcp",
      capabilities: { roots: { listChanged: true } },
    } as unknown as MCPServerConfig;

    const result = await testConnection(config, "server-doc-id", {
      projectId: "project-1",
      serverName: "Excalidraw (App)",
    });

    expect(validateHostedServerMock).toHaveBeenCalledWith(
      "server-doc-id",
      undefined,
      { roots: { listChanged: true } },
      {
        projectId: "project-1",
        serverId: "server-doc-id",
        serverName: "Excalidraw (App)",
      }
    );
    expect(result).toEqual({ success: true, status: "ok" });
  });

  it("routes direct guests through the unified hosted validate path (no body-shape fork)", async () => {
    validateHostedServerMock.mockResolvedValueOnce({
      success: true,
      status: "ok",
    });

    const config = {
      url: "https://mcp.excalidraw.com/mcp",
      capabilities: { roots: { listChanged: true } },
    } as unknown as MCPServerConfig;

    const result = await testConnection(config, "Excalidraw (App)");

    // With actor-owned-projects + AppReady gating, every hosted request —
    // guest or authed — goes through validateHostedServer with the
    // {projectId, serverId} body shape. The legacy guest body-shape fork
    // has been removed.
    expect(validateHostedServerMock).toHaveBeenCalledWith(
      "Excalidraw (App)",
      undefined,
      { roots: { listChanged: true } },
      undefined
    );
    expect(result).toEqual({ success: true, status: "ok" });
  });

  // Codex P2 regression: the hosted branch used to drop
  // `connectionDefaults` entirely, so `mcpProfile.initialize.clientInfo`
  // and `supportedProtocolVersions` pins silently never made it into the
  // upstream MCP `initialize` call. Guard that they now flow into the
  // hosted validate context verbatim.
  it("forwards mcpProfile clientInfo / supportedProtocolVersions on hosted connect", async () => {
    validateHostedServerMock.mockResolvedValueOnce({
      success: true,
      status: "ok",
    });

    const config = {
      url: "https://mcp.excalidraw.com/mcp",
      capabilities: { roots: { listChanged: true } },
    } as unknown as MCPServerConfig;

    await testConnection(config, "server-doc-id", {
      projectId: "project-1",
      serverName: "Excalidraw (App)",
      connectionDefaults: {
        clientInfo: { name: "chatgpt", version: "1.0.0", title: "ChatGPT" },
        supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
      },
    });

    expect(validateHostedServerMock).toHaveBeenCalledWith(
      "server-doc-id",
      undefined,
      { roots: { listChanged: true } },
      expect.objectContaining({
        projectId: "project-1",
        serverId: "server-doc-id",
        serverName: "Excalidraw (App)",
        clientInfo: { name: "chatgpt", version: "1.0.0", title: "ChatGPT" },
        supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
      })
    );
  });

  // Empty/missing pins must remain absent on the wire — the backend
  // hashes `undefined` distinctly from `{}` and we don't want to flip
  // hosted connects into "user opted in" without a real opt-in.
  it("omits clientInfo / supportedProtocolVersions when connectionDefaults has none", async () => {
    validateHostedServerMock.mockResolvedValueOnce({
      success: true,
      status: "ok",
    });

    const config = {
      url: "https://mcp.excalidraw.com/mcp",
      capabilities: { roots: { listChanged: true } },
    } as unknown as MCPServerConfig;

    await testConnection(config, "server-doc-id", {
      projectId: "project-1",
      serverName: "Excalidraw (App)",
      connectionDefaults: {
        headers: { "x-custom": "1" },
        // No clientInfo, no supportedProtocolVersions.
      },
    });

    const callArgs = validateHostedServerMock.mock.calls[0];
    const ctx = callArgs?.[3] as Record<string, unknown> | undefined;
    expect(ctx).toBeDefined();
    expect(ctx).not.toHaveProperty("clientInfo");
    expect(ctx).not.toHaveProperty("supportedProtocolVersions");
  });
});
