import { describe, expect, it } from "vitest";
import { resolveLocalBrowserTools } from "../local-browser-settings";

describe("local Browser tool settings", () => {
  it("adds inherited Browser once and preserves other tools", () => {
    expect(resolveLocalBrowserTools(["bash"], true, true)).toEqual([
      "bash",
      "browser",
    ]);
    expect(
      resolveLocalBrowserTools(["browser", "web_search"], true, true),
    ).toEqual(["web_search", "browser"]);
    expect(resolveLocalBrowserTools(undefined, true, true)).toEqual([
      "browser",
    ]);
  });
  it("honors a local opt-out even when the legacy config contains Browser", () => {
    expect(resolveLocalBrowserTools(["browser", "bash"], false, true)).toEqual([
      "bash",
    ]);
  });
  it("preserves legacy behavior for projects without the new setting", () => {
    expect(resolveLocalBrowserTools(["browser"], undefined, true)).toEqual([
      "browser",
    ]);
    expect(
      resolveLocalBrowserTools(undefined, undefined, true),
    ).toBeUndefined();
  });
  it.each([true, false, undefined])(
    "ignores local setting %s for hosted or unattended execution",
    (enabled) => {
      const toolIds = ["web_search"];
      expect(resolveLocalBrowserTools(toolIds, enabled, false)).toBe(toolIds);
      expect(resolveLocalBrowserTools(["browser"], enabled, false)).toEqual([
        "browser",
      ]);
    },
  );
});
