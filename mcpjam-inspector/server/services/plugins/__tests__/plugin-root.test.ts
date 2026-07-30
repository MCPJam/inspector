import { describe, expect, it } from "vitest";
import {
  needsPluginRoot,
  pluginRootEnv,
  resolvePluginStdioLaunch,
  substitutePluginRoot,
} from "../plugin-root.js";

const ROOT = "/home/tester/.mcpjam/plugins/p1/pl1/abc123";

describe("plugin root substitution", () => {
  it("substitutes both SDK-recognised aliases", () => {
    expect(substitutePluginRoot("${PLUGIN_ROOT}/a", ROOT)).toBe(`${ROOT}/a`);
    expect(substitutePluginRoot("${CODEX_PLUGIN_ROOT}/a", ROOT)).toBe(
      `${ROOT}/a`
    );
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
      needsPluginRoot({ ...base, workingDirectory: "${CODEX_PLUGIN_ROOT}" })
    ).toBe(true);
  });

  it("resolves command, args, env and working directory together", () => {
    const resolved = resolvePluginStdioLaunch(
      {
        command: "${PLUGIN_ROOT}/bin/run",
        args: ["${PLUGIN_ROOT}/server/index.js", "--data=${CODEX_PLUGIN_ROOT}/d"],
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
        CODEX_PLUGIN_ROOT: ROOT,
        CONFIG: `${ROOT}/config.json`,
        API_KEY: "secret",
      },
      workingDirectory: `${ROOT}/work`,
    });
  });

  it("lets a bundle derive its own root env from the injected one", () => {
    const resolved = resolvePluginStdioLaunch(
      { command: "node", args: [], env: { PLUGIN_ROOT: "${PLUGIN_ROOT}/inner" } },
      ROOT
    );
    // The declared value wins, but it is still substituted — no placeholder
    // ever reaches the child process verbatim.
    expect(resolved.env.PLUGIN_ROOT).toBe(`${ROOT}/inner`);
    expect(resolved.env.CODEX_PLUGIN_ROOT).toBe(ROOT);
  });
});
