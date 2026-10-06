import { describe, expect, it } from "vitest";
import { parseArgs } from "../bridge/index.js";

/**
 * Where the bridge finds Codex and its own entrypoints. A sandbox installs
 * both under one `--bootstrap-dir`; a local session splits them along the two
 * trusted sources — the verified vendor pack and the Inspector layer.
 */
describe("the bridge's directories", () => {
  const common = ["--workdir", "/w", "--bridge-state-dir", "/s/b", "--session-data-dir", "/s/d"];

  it("reads Codex and its MCP entrypoint from one bootstrap directory in a sandbox", () => {
    expect(parseArgs([...common, "--bootstrap-dir", "/sandbox/boot"])).toMatchObject({
      vendorDir: "/sandbox/boot",
      layerDir: "/sandbox/boot",
    });
  });

  it("reads Codex from the pack and its own entrypoint from the layer locally", () => {
    expect(
      parseArgs([...common, "--vendor-dir", "/rt/linux-x64/1.0.0/codex", "--layer-dir", "/rt/inspector-layer/abc"]),
    ).toEqual({
      workdir: "/w",
      bridgeStateDir: "/s/b",
      sessionDataDir: "/s/d",
      vendorDir: "/rt/linux-x64/1.0.0/codex",
      layerDir: "/rt/inspector-layer/abc",
    });
  });
});
