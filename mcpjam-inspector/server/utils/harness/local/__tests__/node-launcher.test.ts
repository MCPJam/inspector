import { describe, expect, it } from "vitest";
import { NodeLauncherError, resolveNodeLauncher } from "../node-launcher.js";

describe("resolveNodeLauncher", () => {
  it("uses the process's own node when this is a plain node server", () => {
    expect(
      resolveNodeLauncher({ execPath: "/usr/local/bin/node", isElectron: false })
    ).toEqual({
      executable: "/usr/local/bin/node",
      requiredEnv: {},
      kind: "node",
    });
  });

  it("makes the Electron-as-node invocation explicit rather than implied", () => {
    expect(
      resolveNodeLauncher({ execPath: "/Applications/MCPJam.app/MCPJam", isElectron: true })
    ).toEqual({
      executable: "/Applications/MCPJam.app/MCPJam",
      requiredEnv: { ELECTRON_RUN_AS_NODE: "1" },
      kind: "electron-as-node",
    });
  });

  it("prefers a Node runtime shipped with the bundle", () => {
    expect(
      resolveNodeLauncher({ override: "/opt/mcpjam/runtimes/node/bin/node", isElectron: true })
    ).toEqual({
      executable: "/opt/mcpjam/runtimes/node/bin/node",
      requiredEnv: {},
      kind: "bundled",
    });
  });

  it("refuses a relative launcher, which a PATH would have to resolve", () => {
    expect(() => resolveNodeLauncher({ override: "node" })).toThrow(NodeLauncherError);
    expect(() => resolveNodeLauncher({ execPath: "node", isElectron: false })).toThrow(
      NodeLauncherError
    );
  });
});
