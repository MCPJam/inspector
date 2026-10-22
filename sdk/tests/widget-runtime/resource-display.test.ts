import { describe, expect, it } from "vitest";
import {
  readResourceDisplayHints,
  negotiateResourceDisplayModes,
  openAIDisplayModes,
  pickOpenAIDisplayMode,
  type ResourceDisplayHints,
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

describe("OpenAI display-mode precedence", () => {
  const both = ["inline", "fullscreen"] as const;
  /** Allowed set before initialization and the mode the App starts in. */
  const start = (
    host: readonly string[],
    hints?: ResourceDisplayHints,
    fixed?: string
  ) => {
    const allowed = openAIDisplayModes(host, hints, undefined, fixed);
    return { allowed, initial: pickOpenAIDisplayMode(allowed, hints) };
  };

  it.each<
    [
      string,
      readonly string[],
      ResourceDisplayHints | undefined,
      {
        allowed: string[];
        initial: string | undefined;
      },
    ]
  >([
    [
      "omitted modes mean every host mode",
      both,
      undefined,
      { allowed: [...both], initial: "inline" },
    ],
    [
      "a preference picks the start without narrowing",
      both,
      { preferredDisplayMode: "fullscreen" },
      { allowed: [...both], initial: "fullscreen" },
    ],
    [
      "both declared start fullscreen",
      both,
      { availableDisplayModes: [...both] },
      { allowed: [...both], initial: "fullscreen" },
    ],
    [
      "both declared honour an inline preference",
      both,
      { availableDisplayModes: [...both], preferredDisplayMode: "inline" },
      { allowed: [...both], initial: "inline" },
    ],
    [
      "fullscreen only starts fullscreen",
      both,
      { availableDisplayModes: ["fullscreen"] },
      { allowed: ["fullscreen"], initial: "fullscreen" },
    ],
    [
      "an inline-only host starts inline",
      ["inline"],
      { availableDisplayModes: [...both] },
      { allowed: ["inline"], initial: "inline" },
    ],
    [
      "a preference outside the set is ignored",
      both,
      { availableDisplayModes: ["inline"], preferredDisplayMode: "fullscreen" },
      { allowed: ["inline"], initial: "inline" },
    ],
    [
      "the first host mode is the last resort",
      ["pip", "fullscreen"],
      { availableDisplayModes: ["inline"] },
      { allowed: [], initial: undefined },
    ],
  ])("%s", (_name, host, hints, expected) => {
    expect(start(host, hints)).toEqual(expected);
  });

  it("falls back to the first allowed mode in host order", () => {
    expect(pickOpenAIDisplayMode(["pip", "fullscreen"])).toBe("pip");
    expect(pickOpenAIDisplayMode([])).toBeUndefined();
  });

  it("narrows at initialization only when the App declares modes", () => {
    const hints: ResourceDisplayHints = { availableDisplayModes: [...both] };
    expect(openAIDisplayModes(both, hints)).toEqual([...both]);
    const allowed = openAIDisplayModes(both, hints, ["inline"]);
    expect(allowed).toEqual(["inline"]);
    expect(pickOpenAIDisplayMode(allowed, hints)).toBe("inline");
    expect(openAIDisplayModes(both, hints, [])).toEqual([]);
  });

  it("opens an entrypoint fullscreen whatever its resource declares", () => {
    expect(
      start(
        both,
        { availableDisplayModes: ["inline"], preferredDisplayMode: "inline" },
        "fullscreen"
      )
    ).toEqual({ allowed: ["fullscreen"], initial: "fullscreen" });
  });

  it("refuses an entrypoint the host or the initialized App cannot show fullscreen", () => {
    expect(
      openAIDisplayModes(["inline"], undefined, undefined, "fullscreen")
    ).toEqual([]);
    expect(
      openAIDisplayModes(both, undefined, ["inline"], "fullscreen")
    ).toEqual([]);
    expect(
      openAIDisplayModes(both, undefined, [...both], "fullscreen")
    ).toEqual(["fullscreen"]);
  });
});
