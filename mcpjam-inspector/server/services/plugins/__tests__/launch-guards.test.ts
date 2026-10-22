import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPluginLaunch } from "../launch-guards.js";

const posixOnly = process.platform === "win32" ? it.skip : it;

describe("checkPluginLaunch", () => {
  let base: string;
  let root: string;
  let dataDir: string;
  /** A PATH holding only the Node binary running this test. */
  const env = { PATH: path.dirname(process.execPath) };
  const node = path.basename(process.execPath);
  const local = { remote: false, declaredCommand: node };

  beforeEach(async () => {
    base = await mkdtemp(path.join(tmpdir(), "plugin-launch-"));
    root = path.join(base, "root");
    dataDir = path.join(base, "data");
    await mkdir(path.join(root, "bin"), { recursive: true });
    await mkdir(path.join(root, "..config"), { recursive: true });
    await mkdir(dataDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const launch = (workingDirectory: string, command = node) => ({
    command,
    env,
    workingDirectory,
  });

  it("runs in the plugin root, a folder inside it, or the data directory", async () => {
    for (const cwd of [root, path.join(root, "..config"), dataDir]) {
      expect(
        await checkPluginLaunch(launch(cwd), { root, dataDir }, local),
      ).toBeNull();
    }
  });

  it("refuses a working directory outside both", async () => {
    expect(
      await checkPluginLaunch(launch(base), { root, dataDir }, local),
    ).toEqual({ reason: "working_directory_outside_plugin" });
  });

  posixOnly("refuses a data-directory symlink that leads outside", async () => {
    const outside = path.join(base, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(dataDir, "escape"));
    expect(
      await checkPluginLaunch(
        launch(path.join(dataDir, "escape")),
        { root, dataDir },
        local,
      ),
    ).toEqual({ reason: "working_directory_outside_plugin" });
  });

  it("refuses a working directory that does not exist", async () => {
    expect(
      await checkPluginLaunch(
        launch(path.join(root, "missing")),
        { root, dataDir },
        local,
      ),
    ).toEqual({ reason: "working_directory_missing" });
  });

  it("names a runtime that is not on the PATH", async () => {
    expect(
      await checkPluginLaunch(
        launch(root, "definitely-not-a-runtime"),
        { root, dataDir },
        { remote: false, declaredCommand: "definitely-not-a-runtime" },
      ),
    ).toEqual({
      reason: "runtime_not_found",
      command: "definitely-not-a-runtime",
    });
  });

  posixOnly("runs a bundle executable only once it is executable", async () => {
    const server = path.join(root, "bin", "server");
    await writeFile(server, "#!/bin/sh\n");
    const declared = {
      remote: false,
      declaredCommand: "${PLUGIN_ROOT}/bin/server",
    };
    expect(
      await checkPluginLaunch(
        launch(root, server),
        { root, dataDir },
        declared,
      ),
    ).toEqual({
      reason: "command_not_executable",
      command: "${PLUGIN_ROOT}/bin/server",
    });
    await chmod(server, 0o755);
    expect(
      await checkPluginLaunch(
        launch(root, server),
        { root, dataDir },
        declared,
      ),
    ).toBeNull();
  });

  posixOnly("searches the PATH as the spawn does", async () => {
    for (const file of ["root-server", "bin/path-server", "sub/sub-server"]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "#!/bin/sh\nexit 0\n");
      await chmod(path.join(root, file), 0o755);
    }
    // A working directory reached through a symlink: `..` leaves where the
    // link points, not where it sits.
    const alias = path.join(dataDir, "alias");
    await symlink(path.join(root, "sub"), alias);
    const cases = [
      { command: "path-server", PATH: "./bin" },
      { command: "path-server", PATH: "/nowhere:bin" },
      { command: "path-server", PATH: "." },
      { command: "root-server", PATH: "/nowhere::/elsewhere" },
      { command: "root-server", PATH: "" },
      { command: "root-server", PATH: "/nowhere" },
      { command: "./sub/sub-server", PATH: "/nowhere" },
      { command: "path-server", PATH: "../bin", cwd: alias },
      { command: "sub-server", PATH: ":", cwd: alias },
    ];
    for (const { command, PATH, cwd = root } of cases) {
      const spawned = spawnSync(command, [], { cwd, env: { PATH } });
      const refused = await checkPluginLaunch(
        { command, env: { PATH }, workingDirectory: cwd },
        { root, dataDir },
        { remote: false, declaredCommand: command },
      );
      expect({ command, PATH, cwd, runs: refused === null }).toEqual({
        command,
        PATH,
        cwd,
        runs: spawned.status === 0,
      });
    }
  });

  it("holds a launch in a box to its paths alone", async () => {
    const remote = { remote: true, declaredCommand: "uvx" };
    const boxRoots = { root: "/box/plugin", dataDir: "/box/data" };
    for (const cwd of ["/box/plugin", "/box/plugin/sub", "/box/data/x"]) {
      expect(
        await checkPluginLaunch(launch(cwd, "uvx"), boxRoots, remote),
      ).toBeNull();
    }
    for (const cwd of ["/box/plugin/../etc", "/box", "/etc"]) {
      expect(
        await checkPluginLaunch(launch(cwd, "uvx"), boxRoots, remote),
      ).toEqual({ reason: "working_directory_outside_plugin" });
    }
  });
});
