import { describe, expect, it } from "vitest";
import {
  inlineThenMoveModes,
  inlineThenMoveStart,
  shouldMoveToPanel,
} from "../../src/widget-runtime/inline-then-move.js";

const host = ["inline", "fullscreen"] as const;

describe("inlineThenMoveModes", () => {
  it.each([
    ["no declaration", undefined, ["inline", "fullscreen"]],
    ["both", ["inline", "fullscreen"], ["inline", "fullscreen"]],
    ["inline only", ["inline"], ["inline"]],
    ["fullscreen only", ["fullscreen"], ["fullscreen"]],
    ["an empty list", [], ["inline"]],
    ["pip only", ["pip"], ["inline"]],
    ["pip and fullscreen", ["pip", "fullscreen"], ["fullscreen"]],
  ] as const)("with %s", (_name, appModes, expected) => {
    expect(inlineThenMoveModes(host, appModes)).toEqual(expected);
  });

  it("never offers a mode the host lacks, and ignores host pip", () => {
    expect(inlineThenMoveModes(["inline", "fullscreen", "pip"])).toEqual([
      "inline",
      "fullscreen",
    ]);
    expect(inlineThenMoveModes(["inline"], ["inline", "fullscreen"])).toEqual([
      "inline",
    ]);
    expect(inlineThenMoveModes(["inline"], ["fullscreen"])).toEqual([]);
  });
});

describe("inlineThenMoveStart", () => {
  it.each([
    [["inline", "fullscreen"], "inline"],
    [["inline"], "inline"],
    [["fullscreen"], "fullscreen"],
    [[], "inline"],
  ] as const)("starts %j in %s", (modes, expected) => {
    expect(inlineThenMoveStart(modes)).toBe(expected);
  });
});

describe("shouldMoveToPanel", () => {
  const ready = {
    modes: ["inline", "fullscreen"],
    preferred: "fullscreen",
    toolResultOk: true,
    panelAvailable: true,
  };

  it("moves an App that prefers full screen once its result is in", () => {
    expect(shouldMoveToPanel(ready)).toBe(true);
  });

  it.each([
    ["no preference", { preferred: undefined }],
    ["an inline preference", { preferred: "inline" }],
    ["an error result (isError)", { toolResultOk: false }],
    ["no side panel (compare, mobile)", { panelAvailable: false }],
    ["an inline-only App", { modes: ["inline"] }],
    ["a full-screen-only App, which starts there", { modes: ["fullscreen"] }],
    ["an App that declared []", { modes: inlineThenMoveModes(host, []) }],
    ["an App that declared pip", { modes: inlineThenMoveModes(host, ["pip"]) }],
  ])("stays put with %s", (_name, change) => {
    expect(shouldMoveToPanel({ ...ready, ...change })).toBe(false);
  });
});
