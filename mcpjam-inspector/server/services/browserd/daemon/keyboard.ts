/**
 * Keyboard input over raw CDP, shared by both engines. Unlike
 * `Input.insertText`, `Input.dispatchKeyEvent` fires the key events pages
 * listen for.
 *
 * @see key-events.ts for the name → CDP shape table, which this module sends.
 */
import type { CdpLike } from "./webmcp-bridge";
import { describeKey, insertsText, resolveKeyPress } from "./key-events";

/**
 * Press one chord ("Enter", "Control+A", "Shift+Tab") on this session.
 * `electron-page.test.ts` pins the exact event sequence.
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
    // `keyDown` with no text makes Chromium synthesise a `char` for some keys,
    // so a shortcut can type its own letter.
    type: text === undefined ? "rawKeyDown" : "keyDown",
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    modifiers,
    // `code` alone does not set `KeyboardEvent.location` for keypad keys.
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
 * Split text into graphemes (so ZWJ emoji and flags stay whole). Falls back to
 * code points if `Intl.Segmenter` is missing rather than throwing.
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
 * Type text as keystrokes rather than as an insertion.
 *
 * Deliberate deviations: newlines are pressed as Enter; `\t` is inserted
 * (a real Tab moves focus); graphemes `describeKey` does not know (CJK, emoji)
 * are inserted, since there is no honest `code` for them. `guard` runs before
 * every grapheme so a human takeover stops typing mid-word; it throws.
 */
export async function typeByKeystrokes(
  cdp: CdpLike,
  text: string,
  guard: () => void,
): Promise<void> {
  for (const grapheme of graphemesOf(text)) {
    guard();
    // `\r\n` is one grapheme cluster, so it needs its own case.
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
    // No Shift for capitals: `describeKey("A")` already gives the shifted
    // key/text, and a held Shift would add an extra `keydown`.
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
