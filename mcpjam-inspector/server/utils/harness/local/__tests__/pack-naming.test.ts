import { describe, expect, it } from "vitest";
// eslint-disable-next-line import/extensions -- plain ESM script with a hand-written .d.mts
import * as scriptNaming from "../../../../../scripts/local-harness-pack-harnesses.mjs";
import {
  packAssetStem,
  packReleaseBaseUrl,
  packReleaseTag,
} from "../pack-naming.js";
import { SUPPORTED_LOCAL_HARNESS_IDS } from "../targets.js";

/**
 * The build names a pack; the installer downloads it by name. They are two
 * implementations (one plain ESM, one TypeScript), so this pins them to each
 * other for every harness — an installer that guesses a name the build never
 * wrote downloads nothing, on every machine.
 */
describe("pack names", () => {
  it("keeps Claude Code's shipped names, so pinned Inspectors still find them", () => {
    expect(packReleaseTag("claude-code", "1.0.0")).toBe("local-harness-pack-v1.0.0");
    expect(packAssetStem("claude-code", "linux-x64", "1.0.0")).toBe(
      "local-harness-pack-linux-x64-1.0.0",
    );
  });

  it("puts every other harness's id in both the tag and the asset names", () => {
    expect(packReleaseTag("codex", "1.0.0")).toBe("local-harness-pack-codex-v1.0.0");
    expect(packAssetStem("codex", "win32-x64", "1.0.0")).toBe(
      "local-harness-pack-codex-win32-x64-1.0.0",
    );
    expect(packReleaseBaseUrl("codex", "1.0.0")).toBe(
      "https://github.com/MCPJam/inspector/releases/download/local-harness-pack-codex-v1.0.0/",
    );
  });

  it("agrees with the build script for every harness", () => {
    for (const harnessId of SUPPORTED_LOCAL_HARNESS_IDS) {
      expect(scriptNaming.packReleaseTag(harnessId, "2.3.4")).toBe(
        packReleaseTag(harnessId, "2.3.4"),
      );
      expect(scriptNaming.packReleaseBaseUrl(harnessId, "2.3.4")).toBe(
        packReleaseBaseUrl(harnessId, "2.3.4"),
      );
      for (const target of ["darwin-arm64", "linux-x64", "win32-x64"]) {
        expect(scriptNaming.packAssetStem(harnessId, target, "2.3.4")).toBe(
          packAssetStem(harnessId, target, "2.3.4"),
        );
      }
    }
  });

  it("refuses to name a pack for something that is not a harness id", () => {
    expect(() => scriptNaming.packReleaseTag("../etc", "1.0.0")).toThrow();
  });
});
