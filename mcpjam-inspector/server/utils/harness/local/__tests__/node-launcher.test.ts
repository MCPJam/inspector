import { describe, expect, it } from "vitest";
import { NodeLauncherError, resolveNodeLauncher } from "../node-launcher.js";

describe("resolveNodeLauncher", () => {
  it("uses the process's own node when this is a plain node server", () => {
    expect(
      resolveNodeLauncher({
        execPath: "/usr/local/bin/node",
        isElectron: false,
      }),
    ).toEqual({
      executable: "/usr/local/bin/node",
      requiredEnv: {},
      kind: "node",
    });
  });

  it("makes the Electron-as-node invocation explicit rather than implied", () => {
    expect(
      resolveNodeLauncher({
        execPath: "/Applications/MCPJam.app/MCPJam",
        isElectron: true,
      }),
    ).toEqual({
      executable: "/Applications/MCPJam.app/MCPJam",
      requiredEnv: { ELECTRON_RUN_AS_NODE: "1" },
      kind: "electron-as-node",
    });
  });

  it("refuses a relative launcher, which a PATH would have to resolve", () => {
    expect(() =>
      resolveNodeLauncher({ execPath: "node", isElectron: false }),
    ).toThrow(NodeLauncherError);
  });

  it("refuses an empty launcher path", () => {
    expect(() =>
      resolveNodeLauncher({ execPath: "", isElectron: false }),
    ).toThrow(NodeLauncherError);
  });

  it("offers no unverified override", () => {
    // A caller-supplied "absolute path we promise is Node" would be a trust
    // path with nothing verifying it. The bundled runtime arrives with the CI
    // bundle build, and with that build's digest verification.
    expect(
      Object.keys(resolveNodeLauncher({ execPath: "/usr/bin/node" })),
    ).toEqual(["executable", "requiredEnv", "kind"]);
  });
});
