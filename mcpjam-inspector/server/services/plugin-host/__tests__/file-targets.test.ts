import { describe, expect, it } from "vitest";
import {
  pluginFileTargets,
  pluginFileTargetsWarning,
  refusePluginFileOpen,
} from "../file-targets.js";

const identity = { actorId: "actor", projectId: "project", serverId: "server" };
const contract = {
  version: 1,
  targets: [
    {
      serverId: "server",
      root: "/parts",
      exclusiveWrites: true,
      resources: [{ uri: "cad://part", relativePath: "part.stl" }],
    },
  ],
};
const roots = (root = "/parts") =>
  JSON.stringify([{ ...identity, root }]);

describe("local file target availability", () => {
  it("admits a declared target the operator allows", () => {
    const targets = pluginFileTargets({
      contract,
      identity,
      operatorRoots: roots(),
    });
    expect(targets.placement).toBe("local");
    expect(targets.contract).toBeDefined();
    expect(targets.unavailable).toBeUndefined();
  });
  it.each([
    [undefined, contract, "PLUGIN_LOCAL_FILES_NOT_CONFIGURED"],
    ["", contract, "PLUGIN_LOCAL_FILES_NOT_CONFIGURED"],
    ["not json", contract, "PLUGIN_LOCAL_FILE_ROOTS_INVALID"],
    [roots("/elsewhere"), contract, "PLUGIN_LOCAL_FILE_ROOT_NOT_ALLOWED"],
    [roots(), undefined, "PLUGIN_FILE_TARGETS_NOT_DECLARED"],
    [undefined, undefined, "PLUGIN_FILE_TARGETS_NOT_DECLARED"],
  ])("explains why nothing is usable (roots %j)", (operatorRoots, declared, code) => {
    const targets = pluginFileTargets({
      contract: declared,
      identity,
      operatorRoots,
    });
    expect(targets.contract).toBeUndefined();
    expect(targets.unavailable).toBe(code);
  });
  it("refuses a local open naming the env var and the entry to add", () => {
    let error: any;
    try {
      refusePluginFileOpen(
        { placement: "local", unavailable: "PLUGIN_LOCAL_FILES_NOT_CONFIGURED" },
        identity,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error.code).toBe("PLUGIN_LOCAL_FILES_NOT_CONFIGURED");
    expect(error.diagnostics[0]).toMatchObject({
      level: "error",
      serverId: "server",
      description: expect.stringContaining("MCPJAM_PLUGIN_LOCAL_FILE_ROOTS"),
      details: {
        env: "MCPJAM_PLUGIN_LOCAL_FILE_ROOTS",
        entry: { ...identity, root: "<absolute folder>" },
      },
    });
  });
  it("warns, but only for a declared target that can't be used", () => {
    expect(
      pluginFileTargetsWarning(
        { placement: "local", unavailable: "PLUGIN_LOCAL_FILES_NOT_CONFIGURED" },
        "server",
      )[0],
    ).toMatchObject({ level: "warning", code: "PLUGIN_LOCAL_FILES_NOT_CONFIGURED" });
    expect(
      pluginFileTargetsWarning(
        { placement: "local", unavailable: "PLUGIN_FILE_TARGETS_NOT_DECLARED" },
        "server",
      ),
    ).toEqual([]);
  });
});

describe("remote HTTP servers on the cloud", () => {
  it("are refused even with a declared target and an attached Computer", () => {
    const targets = pluginFileTargets({
      contract: {
        version: 1,
        targets: [
          {
            serverId: "server",
            root: "/home/user/parts",
            exclusiveWrites: true,
            resources: [{ uri: "cad://part", relativePath: "part.stl" }],
          },
        ],
      },
      identity,
      hosted: true,
      computer: true,
      transport: "http",
    });
    expect(targets).toEqual({
      placement: "computer",
      unavailable: "PLUGIN_FILES_REMOTE_SERVER",
    });
    expect(pluginFileTargetsWarning(targets, "server")[0]).toMatchObject({
      level: "warning",
      code: "PLUGIN_FILES_REMOTE_SERVER",
      description: expect.stringContaining("shares no disk"),
    });
  });
});
