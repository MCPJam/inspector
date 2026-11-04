import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPClientManager } from "@mcpjam/sdk";
import { runAppsConformance, runTasksConformance } from "../conformance.js";

afterEach(() => vi.restoreAllMocks());

describe.each([
  ["apps", runAppsConformance],
  ["tasks", runTasksConformance],
] as const)("%s suite connection version", (_name, run) => {
  it.each(["2025-06-18", "2026-07-28"] as const)(
    "pins %s instead of saved connection settings",
    async (protocolVersion) => {
      const connect = vi
        .spyOn(MCPClientManager.prototype, "connectToServer")
        .mockRejectedValue(new Error("Stop before discovery"));
      const response = new Response("{}");
      const baseFetch = vi.fn<typeof fetch>().mockResolvedValue(response);
      const config = {
        url: "https://fixture.test/mcp",
        accessToken: "saved-login",
        baseFetch,
        mcpProtocolVersion: "2025-11-25" as const,
        supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
      };
      await run({ ...config, protocolVersion });
      expect(connect).toHaveBeenCalled();
      for (const [, connection] of connect.mock.calls) {
        expect(connection).toMatchObject({
          mcpProtocolVersion: protocolVersion,
          supportedProtocolVersions: [protocolVersion],
          accessToken: "saved-login",
          baseFetch: expect.any(Function),
        });
        const requestInit = { headers: { "x-fixture": "preserved" } };
        expect(await connection.baseFetch?.(config.url, requestInit)).toBe(
          response,
        );
        expect(baseFetch).toHaveBeenLastCalledWith(config.url, requestInit);
      }
      expect(config.mcpProtocolVersion).toBe("2025-11-25");
      expect(config.baseFetch).toBe(baseFetch);
    },
  );

  it("preserves existing connections when no run pin is supplied", async () => {
    const connect = vi
      .spyOn(MCPClientManager.prototype, "connectToServer")
      .mockRejectedValue(new Error("Stop before discovery"));
    await run({
      url: "https://fixture.test/mcp",
      mcpProtocolVersion: "2025-06-18",
    });
    expect(connect).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ mcpProtocolVersion: "2025-06-18" }),
    );
  });
});
