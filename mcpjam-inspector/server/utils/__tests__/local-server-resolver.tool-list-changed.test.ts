import { describe, expect, it } from "vitest";
import {
  parseConnectionDefaults,
  toMCPServerConfig,
} from "../local-server-resolver.js";

const httpRow = {
  serverConfig: {
    transportType: "http",
    url: "https://example.test/mcp",
    headers: {},
    timeout: 30000,
  },
} as never;

const stdioRow = {
  serverConfig: {
    transportType: "stdio",
    command: "node",
    args: ["server.js"],
    timeout: 30000,
  },
} as never;

/**
 * `mcpProfile.toolListChanged` reaches a LOCAL connect the same way its
 * siblings do: the client puts the resolved leaves on `connectionDefaults`,
 * `parseConnectionDefaults` gates the shape at the /api/mcp boundary, and
 * `toMCPServerConfig` lands them on the SDK config. Both hops used to drop
 * the pair on the floor — the wire carried them and the connection listened
 * and refetched anyway.
 */
describe("local connect: toolListChanged -> MCPServerConfig", () => {
  it("lands both switches on the http config", () => {
    const defaults = parseConnectionDefaults({
      suppressListenChannel: true,
      dropToolListChanged: true,
    });
    expect(defaults).toEqual({
      suppressListenChannel: true,
      dropToolListChanged: true,
    });

    expect(
      toMCPServerConfig(httpRow, {
        suppressListenChannel: defaults?.suppressListenChannel,
        dropToolListChanged: defaults?.dropToolListChanged,
      })
    ).toMatchObject({
      suppressListenChannel: true,
      dropToolListChanged: true,
    });
  });

  it("keeps the conforming default off the config", () => {
    // Only the explicit `true` opts into the simulation; an absent field is
    // what tells the SDK to listen and refetch.
    expect(
      parseConnectionDefaults({
        suppressListenChannel: false,
        dropToolListChanged: false,
      })
    ).toBeUndefined();

    const config = toMCPServerConfig(httpRow, {});
    expect(config).not.toHaveProperty("suppressListenChannel");
    expect(config).not.toHaveProperty("dropToolListChanged");
  });

  it("forwards only the drop half on stdio", () => {
    // `dropToolListChanged` edits an inbound frame, so it applies on stdio.
    // `suppressListenChannel` refuses a GET stream that stdio does not have,
    // so it stays off the config rather than riding along inert — the same
    // split `mirrorToolParamHeaders` already makes.
    const config = toMCPServerConfig(stdioRow, {
      suppressListenChannel: true,
      dropToolListChanged: true,
    });
    expect(config).toMatchObject({ dropToolListChanged: true });
    expect(config).not.toHaveProperty("suppressListenChannel");
  });
});
