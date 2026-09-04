import { describe, expect, it } from "vitest";
import { parseConnectionDefaults, toMCPServerConfig } from "../local-server-resolver.js";

describe("local connect: defaults -> MCPServerConfig", () => {
  it("lands toolCallCancellation on the http config", () => {
    const defaults = parseConnectionDefaults({
      toolCallCancellation: { legacy: false, modern: false },
    });
    expect(defaults?.toolCallCancellation).toBeTruthy();

    const config = toMCPServerConfig(
      {
        serverConfig: {
          transportType: "http",
          url: "https://example.test/mcp",
          headers: {},
          timeout: 30000,
        },
      } as never,
      { toolCallCancellation: defaults?.toolCallCancellation },
    );
    expect(
      (config as { toolCallCancellation?: unknown }).toolCallCancellation,
    ).toEqual({ legacy: false, modern: false });
  });
});
