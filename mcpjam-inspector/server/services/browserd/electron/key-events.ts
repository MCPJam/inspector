/**
 * Playwright key names → what `Input.dispatchKeyEvent` needs.
 *
 * The driver's `press` verb takes a Playwright key string ("Enter",
 * "Control+A", "Shift+Tab") because that is what the Playwright engine has
 * always accepted and the model has been told about. Electron has no Playwright
 * to hand it to — `webContents.debugger` speaks raw CDP — so the translation
 * has to happen somewhere, and doing it here keeps `electron-page.ts` about
 * pages rather than about keyboard trivia.
 *
 * Three details CDP is unforgiving about, each of which produces a silently
 * wrong page rather than an error when you get it wrong:
 *
 *  - `code` is the PHYSICAL key ("KeyA"), `key` is what it produces ("a" or
 *    "A"). A page listening for `event.code` sees nothing if you send only
 *    `key`, and shortcut handlers routinely listen for `code`.
 *  - `text` is what gets INSERTED. Send it while Ctrl or Meta is held and the
 *    character lands in the field on top of the shortcut firing, so Ctrl+A
 *    selects everything and then replaces it with "a". Shift is the exception:
 *    it is how capitals are typed.
 *  - `windowsVirtualKeyCode` still drives a great deal of legacy handling. A
 *    zero there breaks Enter on many forms.
 *
 * Pure and dependency-free, so it is unit-testable without an Electron.
 */

/** The four modifiers CDP knows, and the bit each contributes. */
const MODIFIER_BITS = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
} as const;

export type KeyModifier = keyof typeof MODIFIER_BITS;

export interface CdpKey {
  /** `KeyboardEvent.key` — what the key produces. */
  key: string;
  /** `KeyboardEvent.code` — which physical key it is. */
  code: string;
  /** `windowsVirtualKeyCode`, still load-bearing for legacy handlers. */
  keyCode: number;
  /** The character inserted, when this key inserts one. */
  text?: string;
  /** Set when this key IS a modifier, so a chord can hold it down. */
  modifier?: KeyModifier;
}

/** One key press, already resolved into what the two CDP events need. */
export interface ResolvedKeyPress {
  key: CdpKey;
  /** The modifier bitmask in force, including any this chord holds. */
  modifiers: number;
  /** The modifiers to press before, and release after, in order. */
  chord: readonly CdpKey[];
}

const NAMED_KEYS: Record<string, CdpKey> = {
  // Modifiers, which are also keys in their own right.
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, modifier: "Shift" },
  Control: {
    key: "Control",
    code: "ControlLeft",
    keyCode: 17,
    modifier: "Control",
  },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18, modifier: "Alt" },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91, modifier: "Meta" },

  // `text` on Enter and Tab is not decoration: a textarea inserts a newline
  // from the text, not from the keydown, and the same goes for a tab
  // character in a field that accepts one.
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9, text: "\t" },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },

  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  CapsLock: { key: "CapsLock", code: "CapsLock", keyCode: 20 },
  NumLock: { key: "NumLock", code: "NumLock", keyCode: 144 },
  ScrollLock: { key: "ScrollLock", code: "ScrollLock", keyCode: 145 },
  ContextMenu: { key: "ContextMenu", code: "ContextMenu", keyCode: 93 },

  // The numpad, which is a DIFFERENT physical key from the one on the main
  // row: a page listening for `code` tells `Numpad1` from `Digit1`, and a
  // calculator or a game will act on exactly that difference.
  NumpadEnter: { key: "Enter", code: "NumpadEnter", keyCode: 13, text: "\r" },
  NumpadAdd: { key: "+", code: "NumpadAdd", keyCode: 107, text: "+" },
  NumpadSubtract: { key: "-", code: "NumpadSubtract", keyCode: 109, text: "-" },
  NumpadMultiply: { key: "*", code: "NumpadMultiply", keyCode: 106, text: "*" },
  NumpadDivide: { key: "/", code: "NumpadDivide", keyCode: 111, text: "/" },
  NumpadDecimal: { key: ".", code: "NumpadDecimal", keyCode: 110, text: "." },
};

for (let n = 0; n <= 9; n += 1) {
  NAMED_KEYS[`Numpad${n}`] = {
    key: String(n),
    code: `Numpad${n}`,
    keyCode: 96 + n,
    text: String(n),
  };
}

for (let n = 1; n <= 12; n += 1) {
  NAMED_KEYS[`F${n}`] = { key: `F${n}`, code: `F${n}`, keyCode: 111 + n };
}

/** Punctuation, by the character the unshifted key produces. */
const PUNCTUATION: Record<string, { code: string; keyCode: number }> = {
  "`": { code: "Backquote", keyCode: 192 },
  "-": { code: "Minus", keyCode: 189 },
  "=": { code: "Equal", keyCode: 187 },
  "[": { code: "BracketLeft", keyCode: 219 },
  "]": { code: "BracketRight", keyCode: 221 },
  "\\": { code: "Backslash", keyCode: 220 },
  ";": { code: "Semicolon", keyCode: 186 },
  "'": { code: "Quote", keyCode: 222 },
  ",": { code: "Comma", keyCode: 188 },
  ".": { code: "Period", keyCode: 190 },
  "/": { code: "Slash", keyCode: 191 },
  " ": { code: "Space", keyCode: 32 },
};

/** The unshifted character each shifted one comes from, for `code`. */
const SHIFTED_FROM: Record<string, string> = {
  "~": "`",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

/**
 * One key name → its CDP shape, or `null` when we do not know it.
 *
 * `null` rather than a guess: a fabricated `code` produces a page that saw a
 * key nobody pressed, which is worse than the driver reporting that it could
 * not send this one.
 */
export function describeKey(name: string): CdpKey | null {
  const named = NAMED_KEYS[name];
  if (named) return named;

  // Playwright's own physical-key spellings, which a caller may well use.
  if (/^Key[A-Z]$/.test(name)) {
    const letter = name.slice(3);
    return {
      key: letter.toLowerCase(),
      code: name,
      keyCode: letter.charCodeAt(0),
      text: letter.toLowerCase(),
    };
  }
  if (/^Digit[0-9]$/.test(name)) {
    const digit = name.slice(5);
    return {
      key: digit,
      code: name,
      keyCode: digit.charCodeAt(0),
      text: digit,
    };
  }

  if (name.length !== 1) return null;

  if (/[a-z]/.test(name)) {
    return {
      key: name,
      code: `Key${name.toUpperCase()}`,
      keyCode: name.toUpperCase().charCodeAt(0),
      text: name,
    };
  }
  if (/[A-Z]/.test(name)) {
    // A capital is the same physical key; `keyCode` is the uppercase value
    // either way, which is why both branches charCodeAt the uppercase form.
    return {
      key: name,
      code: `Key${name}`,
      keyCode: name.charCodeAt(0),
      text: name,
    };
  }
  if (/[0-9]/.test(name)) {
    return {
      key: name,
      code: `Digit${name}`,
      keyCode: name.charCodeAt(0),
      text: name,
    };
  }

  const plain = PUNCTUATION[name];
  if (plain)
    return { key: name, code: plain.code, keyCode: plain.keyCode, text: name };

  const base = SHIFTED_FROM[name];
  if (base) {
    const from = PUNCTUATION[base] ?? {
      code: `Digit${base}`,
      keyCode: base.charCodeAt(0),
    };
    return { key: name, code: from.code, keyCode: from.keyCode, text: name };
  }

  return null;
}

/**
 * Resolve a chord ("Control+Shift+K") into the keys to hold and the key to hit.
 *
 * The LAST segment is the key; everything before it is a modifier. Throws with
 * prose the driver already classifies as `target_not_found` when a segment is
 * not a key we know — the model gets "that key isn't one I can send", which is
 * something it can act on, rather than a page that quietly ignored it.
 */
export function resolveKeyPress(chord: string): ResolvedKeyPress {
  // "+" is both the separator AND a key, so an empty last segment means the
  // key IS a plus: "Control++" is Control plus Equal, not a lone Control.
  // Dropping every empty part — which this used to do — silently turned that
  // into a bare modifier press, and a page waiting for zoom-in saw nothing.
  const raw = chord.split("+");
  const segments: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const part = raw[i]!;
    if (part.length > 0) segments.push(part);
    else if (i === raw.length - 1 && segments.length > 0) segments.push("+");
  }
  if (segments.length === 0) segments.push("+");
  const last = segments[segments.length - 1]!;

  const key = describeKey(last);
  if (!key) throw new Error(`no element: unknown key "${last}"`);

  const held: CdpKey[] = [];
  let modifiers = 0;
  for (const name of segments.slice(0, -1)) {
    // "ControlOrMeta" is Playwright's portable spelling. The daemon runs beside
    // the browser it drives, so this process's platform IS the user's.
    const canonical =
      name === "ControlOrMeta"
        ? process.platform === "darwin"
          ? "Meta"
          : "Control"
        : name === "Cmd" || name === "Command"
          ? "Meta"
          : name === "Ctrl"
            ? "Control"
            : name;
    const described = describeKey(canonical);
    if (!described?.modifier) {
      throw new Error(`no element: "${name}" is not a modifier key`);
    }
    held.push(described);
    modifiers |= MODIFIER_BITS[described.modifier];
  }

  // A key that IS a modifier contributes its own bit while it is down.
  if (key.modifier) modifiers |= MODIFIER_BITS[key.modifier];

  // Shift held means the SHIFTED character: Playwright's `press("Shift+a")`
  // types "A", and `press("Shift+1")` types "!". Sending the unshifted key
  // with the Shift bit set does fire the right modifier, but the text CDP
  // inserts is still "a" — so the field ends up with the wrong character
  // while the page's own handlers saw a capital.
  const shifted =
    (modifiers & MODIFIER_BITS.Shift) !== 0 ? shiftedKey(key) : key;

  return { key: shifted, modifiers, chord: held };
}

/**
 * The same physical key, as Shift makes it.
 *
 * Only the character changes: `code` and `keyCode` are the key you pressed,
 * which is the whole point of `code`.
 */
function shiftedKey(key: CdpKey): CdpKey {
  if (key.text === undefined || key.modifier) return key;
  const upper = key.text.toUpperCase();
  if (upper !== key.text) return { ...key, key: upper, text: upper };
  const shiftedChar = SHIFTED_BY_BASE[key.text];
  if (!shiftedChar) return key;
  return { ...key, key: shiftedChar, text: shiftedChar };
}

/** `SHIFTED_FROM` the other way round: unshifted character → shifted one. */
const SHIFTED_BY_BASE: Record<string, string> = Object.fromEntries(
  Object.entries(SHIFTED_FROM).map(([shiftedChar, base]) => [
    base,
    shiftedChar,
  ]),
);

/**
 * Should this press insert text?
 *
 * Only when nothing but Shift is held. Ctrl+A with `text` set selects the
 * document and then overwrites it with "a" — the shortcut fires AND the
 * character is inserted, because CDP treats them as independent.
 */
export function insertsText(modifiers: number): boolean {
  return (
    (modifiers &
      (MODIFIER_BITS.Control | MODIFIER_BITS.Alt | MODIFIER_BITS.Meta)) ===
    0
  );
}

export { MODIFIER_BITS };
