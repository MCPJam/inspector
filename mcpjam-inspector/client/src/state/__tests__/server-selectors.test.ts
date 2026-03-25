import { describe, expect, it } from "vitest";
import type { ServerWithName } from "../app-types";
import {
  getRuntimeServersBySurface,
  getWorkspaceVisibleConnectedOrConnectingServers,
  getWorkspaceVisibleConnectedServerNames,
  getWorkspaceVisibleServers,
} from "../server-selectors";

function createServer(
  name: string,
  overrides: Partial<ServerWithName> = {},
): ServerWithName {
  return {
    name,
    config: { url: "https://example.com/mcp" } as any,
    connectionStatus: "disconnected",
    lastConnectionTime: new Date("2024-01-01T00:00:00.000Z"),
    retryCount: 0,
    enabled: true,
    surface: "workspace",
    ...overrides,
  };
}

describe("server-selectors", () => {
  it("excludes learning runtime servers from workspace-visible collections", () => {
    const servers = {
      workspace: createServer("workspace", { connectionStatus: "connected" }),
      connecting: createServer("connecting", {
        connectionStatus: "connecting",
      }),
      __learning__: createServer("__learning__", {
        connectionStatus: "connected",
        surface: "learning",
      }),
    };

    expect(Object.keys(getWorkspaceVisibleServers(servers))).toEqual([
      "workspace",
      "connecting",
    ]);
    expect(
      Object.keys(getWorkspaceVisibleConnectedOrConnectingServers(servers)),
    ).toEqual(["workspace", "connecting"]);
    expect(getWorkspaceVisibleConnectedServerNames(servers)).toEqual([
      "workspace",
    ]);
  });

  it("can select runtime servers by surface for internal use", () => {
    const servers = {
      workspace: createServer("workspace"),
      __learning__: createServer("__learning__", {
        surface: "learning",
      }),
    };

    expect(
      Object.keys(getRuntimeServersBySurface(servers, "learning")),
    ).toEqual(["__learning__"]);
  });
});
