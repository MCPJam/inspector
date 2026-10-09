import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as internalPluginHost from "../../src/internal/plugin-host.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "..", "package.json"), "utf8")
) as { exports: Record<string, unknown> };

describe("@mcpjam/sdk/internal/plugin-host", () => {
  it("is the only published plugin-host subpath", () => {
    expect(pkg.exports["./internal/plugin-host"]).toBeDefined();
    expect(pkg.exports["./plugin-host"]).toBeUndefined();
  });

  it("exposes what first-party code consumes and nothing else", () => {
    for (const name of [
      "createPluginCapabilityRegistry",
      "disabledPluginFeatures",
      "createPluginSession",
      "reducePluginSession",
      "pluginContextForTurn",
      "pluginInstanceKey",
    ]) {
      expect(typeof (internalPluginHost as Record<string, unknown>)[name]).toBe(
        "function"
      );
    }
    for (const name of [
      "createPluginSessionRunner",
      "createPluginWorkspaceReplay",
      "pluginWorkspaceCheckpoint",
      "parsePluginWorkspaceCheckpoint",
    ]) {
      expect(name in internalPluginHost).toBe(false);
    }
  });
});
