import { describe, expect, it } from "vitest";
import {
  readResourceDisplayHints,
  negotiateResourceDisplayModes,
} from "../../src/widget-runtime/resource-display.js";
const meta = (hints: unknown) => ({ "openai/ui": hints });
describe("resource display metadata", () => {
  it("defaults to host modes and accepts a preference before initialization", () => {
    expect(readResourceDisplayHints()).toBeUndefined();
    expect(negotiateResourceDisplayModes(["inline", "fullscreen"])).toEqual([
      "inline",
      "fullscreen",
    ]);
    const hints = readResourceDisplayHints(
      meta({ preferredDisplayMode: "fullscreen" })
    );
    expect(
      negotiateResourceDisplayModes(["inline", "fullscreen"], hints)
    ).toEqual(["fullscreen"]);
  });
  it("uses listing fallback without merging over explicit content metadata", () => {
    const listing = meta({ preferredDisplayMode: "fullscreen" });
    expect(
      readResourceDisplayHints(undefined, listing)?.preferredDisplayMode
    ).toBe("fullscreen");
    expect(readResourceDisplayHints(meta({}), listing)).toBeUndefined();
    expect(() => readResourceDisplayHints(meta(null), listing)).toThrow();
  });
  it.each([
    { preferredDisplayMode: "pip" },
    { availableDisplayModes: [] },
    { availableDisplayModes: ["inline", "inline"] },
    { availableDisplayModes: ["inline", "arbitrary"] },
    { availableDisplayModes: "fullscreen" },
  ])("refuses malformed mode declarations %j", (hints) => {
    expect(() => readResourceDisplayHints(meta(hints))).toThrow();
  });
  it("narrows after initialization and never invents a mode for an empty intersection", () => {
    const hints = readResourceDisplayHints(
      meta({
        availableDisplayModes: ["inline", "fullscreen"],
        preferredDisplayMode: "fullscreen",
      })
    );
    expect(
      negotiateResourceDisplayModes(["inline", "fullscreen", "pip"], hints, [
        "inline",
      ])
    ).toEqual(["inline"]);
    expect(
      negotiateResourceDisplayModes(["inline"], hints, ["fullscreen"])
    ).toEqual([]);
    expect(
      negotiateResourceDisplayModes(["inline", "fullscreen"], undefined, [])
    ).toEqual([]);
  });
});
