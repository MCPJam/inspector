import { describe, expect, it } from "vitest";
import { NodeLauncherError, resolveNodeLauncher } from "../node-launcher.js";

describe("resolveNodeLauncher", () => {
  it("launches the bridge with the Node binary inside the verified pack", () => {
    expect(
      resolveNodeLauncher({
        bundledNodePath: "/Users/dev/.mcpjam/harness-local/runtime/1/claude-code/bin/node",
      }),
    ).toEqual({
      executable:
        "/Users/dev/.mcpjam/harness-local/runtime/1/claude-code/bin/node",
      requiredEnv: {},
      kind: "bundled",
    });
  });

  it("refuses a relative launcher, which a PATH would have to resolve", () => {
    expect(() => resolveNodeLauncher({ bundledNodePath: "node" })).toThrow(
      NodeLauncherError,
    );
  });

  it("refuses an empty launcher path", () => {
    expect(() => resolveNodeLauncher({ bundledNodePath: "" })).toThrow(
      NodeLauncherError,
    );
  });

  it("offers no way to launch a Node from outside the pack", () => {
    // Both distributions run the pack's own `bin/node`. Electron cannot be the
    // launcher (the `RunAsNode` fuse is off, so `ELECTRON_RUN_AS_NODE` is
    // inert), and the npx server's `process.execPath` is a Node the user
    // installed — outside the tree the digest covers, and therefore outside
    // what consent named. There is deliberately no parameter for either.
    const launcher = resolveNodeLauncher({ bundledNodePath: "/pack/bin/node" });
    expect(Object.keys(launcher)).toEqual([
      "executable",
      "requiredEnv",
      "kind",
    ]);
    expect(launcher.requiredEnv).toEqual({});
  });
});
