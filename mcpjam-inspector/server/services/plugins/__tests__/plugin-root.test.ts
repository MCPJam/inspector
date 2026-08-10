import { describe, expect, it } from "vitest";
import {
  needsPluginRoot,
  pluginRootEnv,
  resolvePluginStdioLaunch,
  substitutePluginPlaceholders,
  substitutePluginRoot,
} from "../plugin-root.js";

const ROOT = "/home/tester/.mcpjam/plugins/p1/pl1/abc123";
const DATA = "/home/tester/.mcpjam/plugin-data/p1/pl1";

describe("plugin root substitution", () => {
  it("substitutes ${PLUGIN_ROOT} and ${PLUGIN_DATA} against their own roots", () => {
    expect(substitutePluginRoot("${PLUGIN_ROOT}/a", ROOT)).toBe(`${ROOT}/a`);
    expect(
      substitutePluginPlaceholders("${PLUGIN_DATA}/a", {
        root: ROOT,
        dataDir: DATA,
      })
    ).toBe(`${DATA}/a`);
    // Distinct roots: the data dir is writable per-plugin state, never the
    // immutable bundle.
    expect(
      substitutePluginPlaceholders("${PLUGIN_ROOT}/x:${PLUGIN_DATA}/y", {
        root: ROOT,
        dataDir: DATA,
      })
    ).toBe(`${ROOT}/x:${DATA}/y`);
  });

  it("leaves ${PLUGIN_DATA} verbatim when no data dir is supplied", () => {
    // The caller's leftover-placeholder guard then refuses the spawn.
    expect(
      substitutePluginPlaceholders("${PLUGIN_DATA}/a", { root: ROOT })
    ).toBe("${PLUGIN_DATA}/a");
  });

  it("substitutes every occurrence, not just the first", () => {
    expect(
      substitutePluginRoot("${PLUGIN_ROOT}:${PLUGIN_ROOT}", ROOT)
    ).toBe(`${ROOT}:${ROOT}`);
  });

  it("leaves ordinary stdio configs untouched", () => {
    const spec = { command: "node", args: ["server.js"], env: { A: "1" } };
    expect(needsPluginRoot(spec)).toBe(false);
    expect(resolvePluginStdioLaunch(spec, ROOT)).toEqual({
      command: "node",
      args: ["server.js"],
      env: { ...pluginRootEnv(ROOT), A: "1" },
    });
  });

  it("detects placeholders in every launch field", () => {
    const base = { command: "node", args: [], env: {} };
    expect(needsPluginRoot({ ...base, command: "${PLUGIN_ROOT}/bin" })).toBe(
      true
    );
    expect(needsPluginRoot({ ...base, args: ["${PLUGIN_ROOT}/x"] })).toBe(true);
    expect(needsPluginRoot({ ...base, env: { X: "${PLUGIN_ROOT}" } })).toBe(
      true
    );
    expect(
      needsPluginRoot({ ...base, workingDirectory: "${PLUGIN_ROOT}" })
    ).toBe(true);
    // A PLUGIN_DATA-only component is still a plugin component — it must
    // route through materialization, never the ordinary spawn path.
    expect(
      needsPluginRoot({ ...base, args: ["${PLUGIN_DATA}/cache.db"] })
    ).toBe(true);
  });

  it("resolves command, args, env and working directory together", () => {
    const resolved = resolvePluginStdioLaunch(
      {
        command: "${PLUGIN_ROOT}/bin/run",
        args: ["${PLUGIN_ROOT}/server/index.js", "--data=${PLUGIN_ROOT}/d"],
        env: { CONFIG: "${PLUGIN_ROOT}/config.json", API_KEY: "secret" },
        workingDirectory: "${PLUGIN_ROOT}/work",
      },
      ROOT
    );

    expect(resolved).toEqual({
      command: `${ROOT}/bin/run`,
      args: [`${ROOT}/server/index.js`, `--data=${ROOT}/d`],
      env: {
        PLUGIN_ROOT: ROOT,
        CONFIG: `${ROOT}/config.json`,
        API_KEY: "secret",
      },
      workingDirectory: `${ROOT}/work`,
    });
  });

  it("injects PLUGIN_ROOT for the child process", () => {
    const resolved = resolvePluginStdioLaunch(
      { command: "node", args: [], env: {} },
      ROOT
    );
    expect(resolved.env).toEqual({ PLUGIN_ROOT: ROOT });
  });

  it("injects and substitutes PLUGIN_DATA when a data dir is supplied", () => {
    const resolved = resolvePluginStdioLaunch(
      {
        command: "node",
        args: ["--cache=${PLUGIN_DATA}/cache.db"],
        env: { STATE_DIR: "${PLUGIN_DATA}/state" },
      },
      ROOT,
      { dataDir: DATA }
    );
    expect(resolved.env).toEqual({
      PLUGIN_ROOT: ROOT,
      PLUGIN_DATA: DATA,
      STATE_DIR: `${DATA}/state`,
    });
    expect(resolved.args).toEqual([`--cache=${DATA}/cache.db`]);
  });
});
