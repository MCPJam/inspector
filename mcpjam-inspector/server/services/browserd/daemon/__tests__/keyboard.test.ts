/**
 * Typing as a PERSON types, rather than as a paste.
 *
 * `Input.insertText` puts the characters in the field and fires no key events
 * at all. A page that reads `event.key` — an autocomplete, a React controlled
 * input with its own handler, an editor with key bindings — sees a field that
 * changed with nobody typing; some ignore it entirely, and the model then
 * reports a search box filled and a page that never searched.
 *
 * The three deliberate deviations are each tested here, because each one is a
 * place where doing the obvious thing produces a page that is quietly wrong:
 * Enter for a newline, an INSERT for a tab (a real Tab moves focus), and an
 * insert for a grapheme no keyboard has.
 */
import { describe, expect, it } from "vitest";
import type { CdpLike } from "../webmcp-bridge";
import { graphemesOf, pressKeyOn, typeByKeystrokes } from "../keyboard";

function fakeCdp() {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const cdp: CdpLike = {
    async send(method, params) {
      sent.push({ method, ...(params ? { params } : {}) });
      return {};
    },
    on() {},
  };
  return { cdp, sent };
}

/** The `key`/`type` pairs, which is what a page's handlers actually see. */
const strokes = (sent: Array<{ method: string; params?: Record<string, unknown> }>) =>
  sent.map((call) =>
    call.method === "Input.insertText"
      ? `insert:${call.params?.text}`
      : `${String(call.params?.type)}:${String(call.params?.key)}`,
  );

describe("typeByKeystrokes", () => {
  it("sends a keyDown and a keyUp per letter, and never an insert", async () => {
    const { cdp, sent } = fakeCdp();
    await typeByKeystrokes(cdp, "hi", () => {});
    expect(strokes(sent)).toEqual([
      "keyDown:h",
      "keyUp:h",
      "keyDown:i",
      "keyUp:i",
    ]);
    expect(sent.every((call) => call.method === "Input.dispatchKeyEvent")).toBe(
      true,
    );
  });

  it("carries the code and the virtual key code a page reads", async () => {
    // `code` is the PHYSICAL key and `key` is what it produces; a page
    // listening for `event.code` — which shortcut handlers routinely do — sees
    // nothing without it, and a zero `windowsVirtualKeyCode` breaks legacy
    // handling on a great many forms.
    const { cdp, sent } = fakeCdp();
    await typeByKeystrokes(cdp, "a", () => {});
    expect(sent[0]!.params).toEqual({
      type: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers: 0,
      text: "a",
    });
  });

  it("types a capital as the capital, with no Shift held", async () => {
    // The character IS the capital, so holding Shift as well would be a second
    // keydown for a single character a person produces with one press.
    const { cdp, sent } = fakeCdp();
    await typeByKeystrokes(cdp, "A", () => {});
    expect(sent[0]!.params).toMatchObject({
      key: "A",
      code: "KeyA",
      text: "A",
      modifiers: 0,
    });
  });

  it("presses Enter for a newline rather than typing one", async () => {
    // A multi-line field gets its newline from Enter's own `text`; a
    // single-line one gets the submit a person would get. Inserting "\\n"
    // gives the first nothing and the second neither.
    const { cdp, sent } = fakeCdp();
    await typeByKeystrokes(cdp, "a\nb", () => {});
    expect(strokes(sent)).toEqual([
      "keyDown:a",
      "keyUp:a",
      "keyDown:Enter",
      "keyUp:Enter",
      "keyDown:b",
      "keyUp:b",
    ]);
  });

  it("treats a carriage return as Enter too", async () => {
    const { cdp, sent } = fakeCdp();
    await typeByKeystrokes(cdp, "\r", () => {});
    expect(strokes(sent)).toEqual(["keyDown:Enter", "keyUp:Enter"]);
  });

  it("INSERTS a tab, because a Tab keystroke moves focus", async () => {
    // The documented deviation: typing "a\\tb" by keystroke would put "b" in
    // the next field. A tab character in a textarea is what the caller asked
    // for, so it goes in as text.
    const { cdp, sent } = fakeCdp();
    await typeByKeystrokes(cdp, "a\tb", () => {});
    expect(strokes(sent)).toEqual([
      "keyDown:a",
      "keyUp:a",
      "insert:\t",
      "keyDown:b",
      "keyUp:b",
    ]);
  });

  it("falls back to an insert for a grapheme it cannot key, and keys the rest", async () => {
    // There is no honest `code` for "é" or for an emoji, and a fabricated one
    // tells the page a key was pressed that exists on no keyboard. Refusing
    // would make text that types fine today untypeable.
    const { cdp, sent } = fakeCdp();
    await typeByKeystrokes(cdp, "aé漢b", () => {});
    expect(strokes(sent)).toEqual([
      "keyDown:a",
      "keyUp:a",
      "insert:é",
      "insert:漢",
      "keyDown:b",
      "keyUp:b",
    ]);
  });

  it("inserts an emoji as ONE grapheme, not as its code points", async () => {
    // A ZWJ family is several code points and one thing you delete with one
    // backspace. Splitting it inserts halves of a character.
    const { cdp, sent } = fakeCdp();
    await typeByKeystrokes(cdp, "👩‍👩‍👧", () => {});
    expect(strokes(sent)).toEqual(["insert:👩‍👩‍👧"]);
  });

  it("keys punctuation and digits", async () => {
    const { cdp, sent } = fakeCdp();
    await typeByKeystrokes(cdp, "a-1.", () => {});
    expect(strokes(sent)).toEqual([
      "keyDown:a",
      "keyUp:a",
      "keyDown:-",
      "keyUp:-",
      "keyDown:1",
      "keyUp:1",
      "keyDown:.",
      "keyUp:.",
    ]);
  });

  it("stops typing when the browser changes hands mid-word", async () => {
    // The reason the guard runs per grapheme rather than once: an insertion is
    // one message and cannot be interrupted, where a word typed letter by
    // letter can — and a person who took the browser should not watch the rest
    // of the sentence arrive under their cursor.
    const { cdp, sent } = fakeCdp();
    let seen = 0;
    await expect(
      typeByKeystrokes(cdp, "abcdef", () => {
        seen += 1;
        if (seen === 3) throw new Error("lease_held: somebody took the browser");
      }),
    ).rejects.toThrow(/lease_held/);
    expect(strokes(sent)).toEqual([
      "keyDown:a",
      "keyUp:a",
      "keyDown:b",
      "keyUp:b",
    ]);
  });

  it("asks the guard before the FIRST grapheme, not after it", async () => {
    const { cdp, sent } = fakeCdp();
    await expect(
      typeByKeystrokes(cdp, "abc", () => {
        throw new Error("lease_held");
      }),
    ).rejects.toThrow(/lease_held/);
    expect(sent).toEqual([]);
  });

  it("sends nothing at all for empty text", async () => {
    const { cdp, sent } = fakeCdp();
    await typeByKeystrokes(cdp, "", () => {
      throw new Error("the guard should not even be asked");
    });
    expect(sent).toEqual([]);
  });
});

describe("graphemesOf", () => {
  it("splits by what a person would call a character", () => {
    expect(graphemesOf("ab")).toEqual(["a", "b"]);
    expect(graphemesOf("👩‍👩‍👧!")).toEqual(["👩‍👩‍👧", "!"]);
    // A flag is two regional indicators and one thing on screen.
    expect(graphemesOf("🇯🇵")).toEqual(["🇯🇵"]);
  });
});

describe("pressKeyOn", () => {
  it("holds the modifiers down around the key, and releases them in reverse", async () => {
    // Reverse so a held Control outlives the Shift inside it.
    const { cdp, sent } = fakeCdp();
    await pressKeyOn(cdp, "Control+Shift+K");
    expect(strokes(sent)).toEqual([
      "rawKeyDown:Control",
      "rawKeyDown:Shift",
      "rawKeyDown:K",
      "keyUp:K",
      "keyUp:Shift",
      "keyUp:Control",
    ]);
  });

  it("sends no text while Ctrl is held", async () => {
    // With `text` set, Ctrl+A selects the document and then overwrites it with
    // "a": CDP treats the shortcut and the insertion as independent.
    const { cdp, sent } = fakeCdp();
    await pressKeyOn(cdp, "Control+a");
    const key = sent.find((call) => call.params?.key === "a");
    expect(key?.params).not.toHaveProperty("text");
    expect(key?.params?.type).toBe("rawKeyDown");
  });

  it("sends Enter with the text a textarea inserts from", async () => {
    const { cdp, sent } = fakeCdp();
    await pressKeyOn(cdp, "Enter");
    expect(sent[0]!.params).toMatchObject({ type: "keyDown", key: "Enter", text: "\r" });
  });

  it("refuses a key it does not know, in prose the driver reads as a bad target", async () => {
    const { cdp } = fakeCdp();
    await expect(pressKeyOn(cdp, "Warp")).rejects.toThrow(
      /no element: unknown key "Warp"/,
    );
  });
});
