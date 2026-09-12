/**
 * Keyboard input over raw CDP, shared by both engines.
 *
 * `Input.dispatchKeyEvent` is the only way to make a page believe a HUMAN
 * pressed a key. `Input.insertText` puts characters in a field and fires no
 * key events at all, which is fine for a paste and wrong for everything that
 * watches the keyboard: a React `onKeyDown` handler, a search box that
 * debounces on `event.key`, a form that only enables Submit once a real
 * keystroke has landed, an editor with its own key bindings.
 *
 * Lifted out of `electron/electron-page.ts`, where the same dispatcher already
 * lived for the `press` verb, for two reasons. It belongs to the DAEMON bundle
 * (the Playwright engine needs it too, and `electron/` is outside that graph),
 * and it is pure: a `CdpLike` in, a sequence of events out, unit-testable
 * without a browser on either engine.
 *
 * @see key-events.ts for the name → CDP shape table, which this module sends.
 */
import type { CdpLike } from "./webmcp-bridge";
import { describeKey, insertsText, resolveKeyPress } from "./key-events";

/**
 * Press one chord ("Enter", "Control+A", "Shift+Tab") on this session.
 *
 * Byte-for-byte the sequence `electron-page.ts` sent before this module
 * existed — modifiers down, the key, the key up, modifiers up in reverse —
 * because `electron-page.test.ts` pins those exact event shapes and the point
 * of moving the code was to share it, not to change what the page sees.
 */
export async function pressKeyOn(cdp: CdpLike, chord: string): Promise<void> {
  const { key, modifiers, chord: held } = resolveKeyPress(chord);

  for (const modifier of held) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: modifier.key,
      code: modifier.code,
      windowsVirtualKeyCode: modifier.keyCode,
      modifiers,
    });
  }

  const text = insertsText(modifiers) ? key.text : undefined;
  await cdp.send("Input.dispatchKeyEvent", {
    // `keyDown` with text, `rawKeyDown` without: sending `keyDown` and no
    // text makes Chromium synthesise a `char` event for some keys and not
    // others, which is how a shortcut ends up typing its own letter.
    type: text === undefined ? "rawKeyDown" : "keyDown",
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    modifiers,
    // `code` alone does not reach `KeyboardEvent.location`, so without this
    // the page sees a keypad press at location 0 — indistinguishable from
    // the number row to anything that routes them differently.
    ...(key.keypad ? { isKeypad: true } : {}),
    ...(text === undefined ? {} : { text }),
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    modifiers,
    ...(key.keypad ? { isKeypad: true } : {}),
  });

  // Released in reverse, so a held Control outlives the Shift inside it.
  for (const modifier of [...held].reverse()) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: modifier.key,
      code: modifier.code,
      windowsVirtualKeyCode: modifier.keyCode,
      modifiers: 0,
    });
  }
}

/**
 * Split text into what a person would call "characters".
 *
 * `Array.from` splits by code POINT, which is already better than indexing
 * (an emoji is one code point, not two UTF-16 units) but still wrong for a
 * family emoji joined by ZWJs or a flag built from regional indicators: those
 * are several code points and one thing you delete with one backspace. A
 * grapheme is the unit the page will show and the unit the model meant.
 *
 * `Intl.Segmenter` is in every Node the daemon runs on; the fallback is here
 * because the daemon is bundled and shipped to a box we do not fully control,
 * and degrading to code points types the text slightly wrong rather than
 * throwing on the way to typing nothing at all.
 */
export function graphemesOf(text: string): string[] {
  const Segmenter = (
    Intl as unknown as {
      Segmenter?: new (
        locale?: string,
        options?: { granularity?: string },
      ) => { segment(input: string): Iterable<{ segment: string }> };
    }
  ).Segmenter;
  if (!Segmenter) return Array.from(text);
  const segmenter = new Segmenter(undefined, { granularity: "grapheme" });
  return [...segmenter.segment(text)].map((part) => part.segment);
}

/**
 * Type text as KEYSTROKES rather than as an insertion.
 *
 * The difference the whole module exists for: `Input.insertText` puts the
 * characters in the field and fires no `keydown`, so a site that reads
 * `event.key` — an autocomplete, a React controlled input with its own
 * handler, an editor with key bindings — sees a field that changed with
 * nobody typing. Some of them ignore it entirely; the model then reports a
 * search box filled and a page that never searched.
 *
 * Three deviations, each deliberate:
 *
 *  - `\n` and `\r` are sent as ENTER. A page with a multi-line field gets its
 *    newline from Enter's own `text`, and a page with a single-line one gets
 *    the submit it would get from a person — which is what typing a newline
 *    into a search box means.
 *  - `\t` is INSERTED, not pressed. A real Tab keystroke moves focus, so
 *    typing "a\tb" by keystroke would put "b" in the next field. A tab
 *    character in a textarea is what the caller asked for.
 *  - A grapheme `describeKey` does not know (a CJK character, an emoji, an
 *    accented letter off the US layout) is INSERTED on its own. There is no
 *    honest `code` for it — a fabricated one is a page told a key was pressed
 *    that does not exist on any keyboard — and refusing would make text that
 *    types fine today untypeable.
 *
 * `guard` runs before every grapheme, so a person taking the browser mid-word
 * stops the rest rather than finishing the sentence under their cursor. It
 * throws; nothing here catches it.
 */
export async function typeByKeystrokes(
  cdp: CdpLike,
  text: string,
  guard: () => void,
): Promise<void> {
  for (const grapheme of graphemesOf(text)) {
    guard();
    // ALL THREE LINE ENDINGS, and `\r\n` is why this is not just two cases:
    // a CR followed by an LF is ONE extended grapheme cluster, so `Segmenter`
    // hands it over whole. Matching only the singles let it fall through to
    // `describeKey`, which answers `null` for a two-character name, and the
    // text went in through `Input.insertText` — no `keydown`, so Enter-driven
    // submit and any `event.key` handler saw nothing on Windows-style input.
    if (grapheme === "\n" || grapheme === "\r" || grapheme === "\r\n") {
      await pressKeyOn(cdp, "Enter");
      continue;
    }
    if (grapheme === "\t") {
      await cdp.send("Input.insertText", { text: grapheme });
      continue;
    }
    const key = describeKey(grapheme);
    if (!key) {
      await cdp.send("Input.insertText", { text: grapheme });
      continue;
    }
    // No modifier bit for a capital: `describeKey("A")` already answers
    // `key: "A"`, `text: "A"` on `code: "KeyA"`, which is what a page reads
    // off a Shift-held press. Holding Shift as well would be a second,
    // separate `keydown` for the model's "type Hello" — an event a person
    // typing one character does not produce twice.
    const common = {
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      modifiers: 0,
      ...(key.keypad ? { isKeypad: true } : {}),
    };
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...common,
      text: key.text ?? grapheme,
    });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
  }
}
