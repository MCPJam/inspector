import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MCPServerConfig } from "@mcpjam/sdk";

const validateHostedServerMock = vi.fn();

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/apis/web/servers-api", () => ({
  validateHostedServer: (...args: unknown[]) => validateHostedServerMock(...args),
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

import { reconnectServer, testConnection } from "../mcp-api";

describe("mcp-api hosted-mode reconnect hardening", () => {
  beforeEach(() => {
    validateHostedServerMock.mockReset();
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
    );
    expect(result).toEqual({ success: true, status: "ok" });
  });
});
