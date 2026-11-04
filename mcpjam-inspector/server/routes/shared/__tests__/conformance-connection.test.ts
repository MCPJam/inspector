import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPAuthError, MCPClientManager } from "@mcpjam/sdk";
import { checkConformanceConnection } from "../conformance-connection.js";
import { createManagedMcpClient } from "../../../../../sdk/src/mcp-client-manager/managed-mcp-client-factory.js";

const { guardedFetch } = vi.hoisted(() => ({ guardedFetch: vi.fn() }));
vi.mock("../conformance.js", () => ({
  createConformanceFetch: () => guardedFetch,
}));
vi.mock("../../../config.js", async (original) => ({
  ...(await original<typeof import("../../../config.js")>()),
  HOSTED_MODE: true,
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("temporary conformance connection", () => {
  const config = {
    url: "https://bart.test/mcp",
    accessToken: "saved-token",
  };

  it("connects with the exact pin and saved login, then closes its own client", async () => {
    const connect = vi
      .spyOn(MCPClientManager.prototype, "connectToServer")
      .mockResolvedValue(
        createManagedMcpClient({
          clientOptions: { capabilities: {} },
          clientInfo: { name: "connection-check-test", version: "1.0.0" },
        }),
      );
    vi.spyOn(
      MCPClientManager.prototype,
      "getNegotiatedProtocolVersion",
    ).mockReturnValue("2026-07-28");
    const disconnect = vi.spyOn(
      MCPClientManager.prototype,
      "disconnectAllServers",
    );
    const listTools = vi.spyOn(MCPClientManager.prototype, "listTools");
    expect(await checkConformanceConnection(config, "2026-07-28")).toEqual({
      status: "ready",
      protocolVersion: "2026-07-28",
    });
    expect(connect).toHaveBeenCalledWith(
      "bart.test",
      expect.objectContaining({
        accessToken: "saved-token",
        mcpProtocolVersion: "2026-07-28",
        supportedProtocolVersions: ["2026-07-28"],
        baseFetch: guardedFetch,
      }),
    );
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(listTools).not.toHaveBeenCalled();
    expect(config).not.toHaveProperty("mcpProtocolVersion");
  });

  it("returns Auto's negotiated version without a pin or accept-list", async () => {
    const connect = vi
      .spyOn(MCPClientManager.prototype, "connectToServer")
      .mockResolvedValue(
        createManagedMcpClient({
          clientOptions: { capabilities: {} },
          clientInfo: { name: "test", version: "1" },
        }),
      );
    vi.spyOn(
      MCPClientManager.prototype,
      "getNegotiatedProtocolVersion",
    ).mockReturnValue("2025-06-18");
    expect(await checkConformanceConnection(config, "auto")).toEqual({
      status: "ready",
      protocolVersion: "2025-06-18",
    });
    expect(connect).toHaveBeenCalledWith(
      "bart.test",
      expect.objectContaining({
        mcpProtocolVersion: undefined,
        supportedProtocolVersions: undefined,
        baseFetch: guardedFetch,
      }),
    );
  });

  it("does not invent a version when negotiation supplies none", async () => {
    vi.spyOn(MCPClientManager.prototype, "connectToServer").mockResolvedValue(
      createManagedMcpClient({
        clientOptions: { capabilities: {} },
        clientInfo: { name: "test", version: "1" },
      }),
    );
    vi.spyOn(
      MCPClientManager.prototype,
      "getNegotiatedProtocolVersion",
    ).mockReturnValue(undefined);
    expect(await checkConformanceConnection(config, "auto")).toMatchObject({
      status: "failed",
    });
  });

  it("closes the temporary client after a version refusal", async () => {
    vi.spyOn(MCPClientManager.prototype, "connectToServer").mockRejectedValue(
      Object.assign(new Error("Refused"), {
        name: "ProtocolVersionPinUnsupported",
        protocolVersion: "2026-07-28",
        supportedVersions: ["2025-06-18", "<html>private</html>"],
      }),
    );
    const disconnect = vi.spyOn(
      MCPClientManager.prototype,
      "disconnectAllServers",
    );
    expect(await checkConformanceConnection(config, "2026-07-28")).toEqual({
      status: "unsupported",
      protocolVersion: "2026-07-28",
      supportedVersions: ["2025-06-18"],
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not return a hosted server's private error body", async () => {
    vi.spyOn(MCPClientManager.prototype, "connectToServer").mockRejectedValue(
      Object.assign(new Error("PRIVATE_BODY access_token=secret"), {
        name: "SdkHttpError",
        status: 503,
      }),
    );
    const result = await checkConformanceConnection(config, "2026-07-28");
    expect(result).toEqual({
      status: "failed",
      message: "The MCP server responded with HTTP 503.",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY");
  });

  it.each([
    [new MCPAuthError("Expired", 401), "auth-required"],
    [new MCPAuthError("Forbidden", 403), "failed"],
    [new Error("fetch failed"), "failed"],
    [Object.assign(new Error("Timeout"), { name: "TimeoutError" }), "failed"],
  ])("keeps %s distinct from a version refusal", async (error, status) => {
    vi.spyOn(MCPClientManager.prototype, "connectToServer").mockRejectedValue(
      error,
    );
    const disconnect = vi.spyOn(
      MCPClientManager.prototype,
      "disconnectAllServers",
    );
    expect(await checkConformanceConnection(config, "2026-07-28")).toEqual({
      status,
      message: expect.any(String),
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
