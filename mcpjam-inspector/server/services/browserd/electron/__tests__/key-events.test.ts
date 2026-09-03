import { describe, expect, it } from "vitest";
import {
  describeKey,
  insertsText,
  MODIFIER_BITS,
  resolveKeyPress,
} from "../key-events";

describe("key-events — a key the page can actually recognise", () => {
  it("carries the physical key, not just the character", () => {
    // A page listening for `event.code` — which every shortcut handler does —
    // sees nothing at all if only `key` is sent.
    expect(describeKey("a")).toMatchObject({
      key: "a",
      code: "KeyA",
      keyCode: 65,
    });
    expect(describeKey("A")).toMatchObject({
      key: "A",
      code: "KeyA",
      keyCode: 65,
    });
    expect(describeKey("7")).toMatchObject({ key: "7", code: "Digit7" });
  });

  it("gives Enter and Tab the text they insert", () => {
    // A textarea gets its newline from the TEXT, not from the keydown. Without
    // this, Enter fires handlers and leaves the field unchanged.
    expect(describeKey("Enter")).toMatchObject({ text: "\r", keyCode: 13 });
    expect(describeKey("Tab")).toMatchObject({ text: "\t", keyCode: 9 });
  });

  it("resolves a shifted character to the physical key it comes from", () => {
    expect(describeKey("?")).toMatchObject({ key: "?", code: "Slash" });
    expect(describeKey("!")).toMatchObject({ key: "!", code: "Digit1" });
  });

  it("accepts Playwright's own physical spellings", () => {
    expect(describeKey("KeyQ")).toMatchObject({ key: "q", code: "KeyQ" });
    expect(describeKey("F5")).toMatchObject({
      key: "F5",
      code: "F5",
      keyCode: 116,
    });
  });

  it("refuses a key it does not know rather than inventing one", () => {
    // A fabricated `code` is a page that saw a key nobody pressed.
    expect(describeKey("Frobnicate")).toBeNull();
    expect(() => resolveKeyPress("Frobnicate")).toThrow(/no element/);
  });
});

describe("key-events — chords", () => {
  it("holds the modifiers and hits the last key", () => {
    const { key, modifiers, chord } = resolveKeyPress("Control+Shift+K");
    expect(key.code).toBe("KeyK");
    expect(chord.map((k) => k.key)).toEqual(["Control", "Shift"]);
    expect(modifiers).toBe(MODIFIER_BITS.Control | MODIFIER_BITS.Shift);
  });

  it("does not insert text while Control or Meta is held", () => {
    // Ctrl+A with `text` set selects the document and then REPLACES it with
    // "a": CDP fires the shortcut and inserts the character independently.
    expect(insertsText(resolveKeyPress("Control+a").modifiers)).toBe(false);
    expect(insertsText(resolveKeyPress("Meta+v").modifiers)).toBe(false);
    // Shift is how capitals are typed, so it is the one that still inserts.
    expect(insertsText(resolveKeyPress("Shift+a").modifiers)).toBe(true);
    expect(insertsText(resolveKeyPress("a").modifiers)).toBe(true);
  });

  it("counts a modifier pressed on its own", () => {
    expect(resolveKeyPress("Shift").modifiers).toBe(MODIFIER_BITS.Shift);
  });

  it("treats a bare + as the key it is, not a separator", () => {
    expect(resolveKeyPress("+").key.code).toBe("Equal");
  });

  it("refuses a chord whose held segment is not a modifier", () => {
    expect(() => resolveKeyPress("q+a")).toThrow(/not a modifier/);
  });
});
