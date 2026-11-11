/**
 * `fitChips` is the picker's fitting rule, lifted out. These are the picker
 * panel's own chip cases at its default 200px, so a drift between the two
 * shows here as well as there.
 */
import { describe, expect, it } from "vitest";

import { chipWidth, fitChips } from "../components/server-chips";

const ROOM = 200;

describe("fitChips", () => {
  it("fits to the room chips take, reserving room for +N", () => {
    // A third `excalidraw` fits alone (192 of 200px) but not with `+3`.
    const names = Array.from({ length: 6 }, () => "excalidraw");
    const { shown, hidden } = fitChips(names, ROOM);
    expect(shown).toHaveLength(2);
    expect(hidden).toHaveLength(4);
  });

  it("shows three short names whole", () => {
    expect(fitChips(["excalidraw", "sample", "sample"], ROOM).hidden).toEqual(
      [],
    );
  });

  it("counts padding, as measured in the app", () => {
    const { shown, hidden } = fitChips(
      ["big-mcp", "Excalidraw (App)", "no-existe.invalid"],
      ROOM,
    );
    expect(shown).toEqual(["big-mcp", "Excalidraw (App)"]);
    expect(hidden).toEqual(["no-existe.invalid"]);
  });

  it("charges wide glyphs double", () => {
    const { shown, hidden } = fitChips(
      ["日本語サーバー", "中文服务器", "한국어서버"],
      ROOM,
    );
    expect(shown).toEqual(["日本語サーバー"]);
    expect(hidden).toHaveLength(2);
    expect(chipWidth("中")).toBeGreaterThan(chipWidth("a"));
  });

  it("always shows the first chip, however wide", () => {
    const wide = "a-server-name-longer-than-the-whole-budget";
    expect(fitChips([wide, "b"], ROOM)).toEqual({
      shown: [wide],
      hidden: ["b"],
    });
  });

  it("shows nothing for no names", () => {
    expect(fitChips([], ROOM)).toEqual({ shown: [], hidden: [] });
  });
});
