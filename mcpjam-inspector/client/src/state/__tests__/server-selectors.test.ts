import { describe, expect, it } from "vitest";
import { createServer } from "@/test/factories";
import {
  getRuntimeServersBySurface,
  getWorkspaceVisibleConnectedServers,
  getWorkspaceVisibleConnectedOrConnectingServers,
  getWorkspaceVisibleConnectedServerNames,
  getWorkspaceVisibleServers,
} from "../server-selectors";

describe("server-selectors", () => {
  it("excludes learning runtime servers from workspace-visible collections", () => {
    const servers = {
      workspace: createServer({
        name: "workspace",
        connectionStatus: "connected",
        enabled: true,
        surface: "workspace",
      }),
      connecting: createServer({
        name: "connecting",
        connectionStatus: "connecting",
        enabled: true,
        surface: "workspace",
      }),
      __learning__: createServer({
        name: "__learning__",
        connectionStatus: "connected",
        enabled: true,
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
    expect(Object.keys(getWorkspaceVisibleConnectedServers(servers))).toEqual([
      "workspace",
    ]);
    expect(getWorkspaceVisibleConnectedServerNames(servers)).toEqual([
      "workspace",
    ]);
  });

  it("can select runtime servers by surface for internal use", () => {
    const servers = {
      workspace: createServer({ name: "workspace", surface: "workspace" }),
      __learning__: createServer({
        name: "__learning__",
        surface: "learning",
      }),
    };

    expect(
      Object.keys(getRuntimeServersBySurface(servers, "learning")),
    ).toEqual(["__learning__"]);
  });
});
