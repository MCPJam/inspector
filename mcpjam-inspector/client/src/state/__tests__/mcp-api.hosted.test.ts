import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";

const validateHostedServerMock = vi.fn();
const webPostMock = vi.fn();
const buildGuestServerRequestMock = vi.fn();
const isGuestModeMock = vi.fn(() => false);

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/apis/web/servers-api", () => ({
  validateHostedServer: (...args: unknown[]) =>
    validateHostedServerMock(...args),
}));

vi.mock("@/lib/apis/web/base", () => ({
  webPost: (...args: unknown[]) => webPostMock(...args),
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

vi.mock("@/lib/apis/web/context", () => ({
  buildGuestServerRequest: (...args: unknown[]) =>
    buildGuestServerRequestMock(...args),
  isGuestMode: () => isGuestModeMock(),
}));

import { reconnectServer, testConnection } from "../mcp-api";

describe("mcp-api hosted-mode reconnect hardening", () => {
  beforeEach(() => {
    validateHostedServerMock.mockReset();
    webPostMock.mockReset();
    buildGuestServerRequestMock.mockReset();
    isGuestModeMock.mockReset();
    isGuestModeMock.mockReturnValue(false);
  });

  it("normalizes hosted workspace timing errors for testConnection", async () => {
    validateHostedServerMock.mockRejectedValueOnce(
      new Error("Hosted workspace is not available yet"),
    );

    const result = await testConnection({} as MCPServerConfig, "server-1");

    expect(result).toEqual({
      success: false,
      error: "Hosted workspace is still loading. Please try again in a moment.",
    });
  });

  it("normalizes hosted server lookup errors for reconnectServer", async () => {
    validateHostedServerMock.mockRejectedValueOnce(
      new Error('Hosted server not found for "server-2"'),
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
    );
    expect(result).toEqual({ success: true, status: "ok" });
  });

  it("validates direct guests using the provided server config instead of hosted context lookup", async () => {
    isGuestModeMock.mockReturnValue(true);
    buildGuestServerRequestMock.mockReturnValue({
      serverUrl: "https://mcp.excalidraw.com/mcp",
    });
    webPostMock.mockResolvedValueOnce({
      success: true,
      status: "ok",
    });

    const config = {
      url: "https://mcp.excalidraw.com/mcp",
      capabilities: { roots: { listChanged: true } },
    } as unknown as MCPServerConfig;

    const result = await testConnection(config, "Excalidraw (App)");

    expect(buildGuestServerRequestMock).toHaveBeenCalledWith(
      config,
      undefined,
      { roots: { listChanged: true } },
      "Excalidraw (App)",
    );
    expect(webPostMock).toHaveBeenCalledWith("/api/web/servers/validate", {
      serverUrl: "https://mcp.excalidraw.com/mcp",
    });
    expect(validateHostedServerMock).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, status: "ok" });
  });
});
