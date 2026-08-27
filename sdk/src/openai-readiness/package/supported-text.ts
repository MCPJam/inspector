/**
 * The character rules listing text has to satisfy.
 *
 * WHY THIS IS NOT "STRIP THE WEIRD CHARACTERS". A preflight that sanitised
 * would report a pass on text the portal rejects, because the portal validates
 * what was UPLOADED. So this only ever reports; the caller decides.
 *
 * WHY THE SEPARATORS ARE HERE AT ALL. U+2028 and U+2029 are the ones nobody
 * expects. They survive a copy-paste out of a design tool, they are invisible
 * in every editor, and they terminate a line in a JavaScript string literal —
 * which is exactly why a listing field carrying one breaks somewhere far away
 * from the field.
 *
 * Pure. Safe from the browser entry.
 */

/** One offending character, located so a submitter can find it. */
export interface UnsupportedCharacter {
  /** Code point, as `U+XXXX`. */
  codePoint: string;
  /** Index into the string, in code units. */
  index: number;
  kind: "control" | "line-separator" | "paragraph-separator";
}

const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;

/**
 * Whether a code point is a control character the fields disallow.
 *
 * TAB, LF and CR are excluded from the C0 range: a multi-line description
 * legitimately contains newlines, and flagging them would fail nearly every
 * real submission. Everything else in C0, plus DEL and the C1 range, is the
 * kind of byte that only arrives by accident.
 */
function controlKind(
  codePoint: number,
): UnsupportedCharacter["kind"] | undefined {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) {
    return undefined;
  }
  if (codePoint <= 0x1f) return "control";
  if (codePoint === 0x7f) return "control";
  if (codePoint >= 0x80 && codePoint <= 0x9f) return "control";
  if (codePoint === LINE_SEPARATOR) return "line-separator";
  if (codePoint === PARAGRAPH_SEPARATOR) return "paragraph-separator";
  return undefined;
}

/** Every unsupported character in `value`, in order. */
export function findUnsupportedCharacters(
  value: string,
): UnsupportedCharacter[] {
  const found: UnsupportedCharacter[] = [];
  // Iterated by code POINT so an astral character is not mistaken for two
  // surrogates, while the reported index stays a code-unit offset the caller
  // can slice with.
  let index = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined) {
      const kind = controlKind(codePoint);
      if (kind) {
        found.push({
          codePoint: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
          index,
          kind,
        });
      }
    }
    index += character.length;
  }
  return found;
}

/** Whether `value` is free of unsupported characters. */
export function isSupportedText(value: string): boolean {
  return findUnsupportedCharacters(value).length === 0;
}

/**
 * Whether a string's leading or trailing whitespace would be trimmed.
 *
 * Reported rather than trimmed, for the same reason nothing here sanitises: the
 * portal compares what was uploaded, and a submitter whose name is
 * `"My Plugin "` should be told, not quietly fixed.
 */
export function hasSurroundingWhitespace(value: string): boolean {
  return value !== value.trim();
}
