/**
 * A minimal HTML scanner for the design-guideline lints.
 *
 * WHY NOT REGEXES. The lints ask structural questions — "does this widget have
 * interactive elements", "does anything set a minimum touch target" — and
 * answering them with `/<(button|a)\b/i` over raw markup is wrong twice over.
 * It matches a `<button>` written inside an HTML comment or a JavaScript
 * string, which produces confident nonsense about a widget that has no button
 * at all; and it is exactly the shape static analysis flags as an incomplete
 * tag filter, because that is what it is.
 *
 * A scanner answers the same questions correctly and cheaply. It is not an
 * HTML parser: no tree, no error recovery, no entity handling beyond the
 * obvious. It knows which tags appear, which attributes are used, and what the
 * `<style>` blocks contain — which is the whole of what the lints need.
 *
 * Pure data. Safe from the browser entry.
 */

/** What one pass over a widget's markup establishes. */
export interface ScannedHtml {
  /** Lowercased tag names that appear as real elements. */
  tags: Set<string>;
  /** Lowercased attribute names that appear on any element. */
  attributes: Set<string>;
  /**
   * Every declaration the document carries: `<style>` bodies AND the value of
   * every inline `style` attribute.
   *
   * Both, because a widget written as `<button style="min-height: 44px">`
   * satisfies the touch-target guideline exactly as well as one with a
   * stylesheet — and a lint that only read `<style>` blocks would report a
   * violation the author already fixed.
   */
  styleText: string;
  /** Concatenated contents of every `<script>` element. */
  scriptText: string;
}

const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);

/** Is this the start of a doctype declaration? A prefix test, not a pattern. */
function isDoctypeAt(html: string, at: number): boolean {
  return html.slice(at, at + 9).toLowerCase() === "<!doctype";
}

function isNameChar(char: string): boolean {
  return (
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    (char >= "0" && char <= "9") ||
    char === "-" ||
    char === "_" ||
    char === ":"
  );
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

/**
 * Scan a widget's markup once.
 *
 * Comments and raw-text element bodies are skipped rather than searched, so a
 * `<button>` mentioned in a comment or built inside a script string never
 * appears in `tags` — which is the false positive the regexes it replaces
 * produced.
 */
export function scanHtml(html: string): ScannedHtml {
  const tags = new Set<string>();
  const attributes = new Set<string>();
  const styleParts: string[] = [];
  const scriptParts: string[] = [];

  let index = 0;
  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (isDoctypeAt(html, lt)) {
      const end = html.indexOf(">", lt + 2);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    let cursor = lt + 1;
    const closing = html[cursor] === "/";
    if (closing) cursor += 1;

    const nameStart = cursor;
    while (cursor < html.length && isNameChar(html[cursor])) cursor += 1;
    if (cursor === nameStart) {
      // A `<` that opens nothing — "a < b" in prose.
      index = lt + 1;
      continue;
    }
    const name = html.slice(nameStart, cursor).toLowerCase();
    if (!closing) tags.add(name);

    // Walk the attributes, quote-aware, to the tag's real end.
    let quote: string | undefined;
    let attributeStart = -1;
    let selfClosing = false;
    while (cursor < html.length) {
      const char = html[cursor];
      if (quote) {
        if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        selfClosing = html[cursor - 1] === "/";
        cursor += 1;
        break;
      } else if (!closing) {
        if (attributeStart === -1 && isNameChar(char) && isSpace(html[cursor - 1])) {
          attributeStart = cursor;
        } else if (attributeStart !== -1 && !isNameChar(char)) {
          const attributeName = html.slice(attributeStart, cursor).toLowerCase();
          attributes.add(attributeName);
          if (attributeName === "style") {
            const value = readAttributeValue(html, cursor);
            if (value) styleParts.push(value);
          }
          attributeStart = -1;
        }
      }
      cursor += 1;
    }
    if (attributeStart !== -1) {
      attributes.add(html.slice(attributeStart, cursor).toLowerCase());
    }

    if (closing || selfClosing || !RAW_TEXT_ELEMENTS.has(name)) {
      index = cursor;
      continue;
    }

    // Raw-text element: capture its body and skip past the end tag, tolerating
    // `</style >` and refusing to stop at `</styles>`.
    const lower = html.toLowerCase();
    const needle = `</${name}`;
    let search = cursor;
    let bodyEnd = html.length;
    let resumeAt = html.length;
    for (;;) {
      const at = lower.indexOf(needle, search);
      if (at === -1) break;
      const after = html[at + needle.length];
      if (after === undefined || after === ">" || isSpace(after)) {
        bodyEnd = at;
        const close = html.indexOf(">", at);
        resumeAt = close === -1 ? html.length : close + 1;
        break;
      }
      search = at + needle.length;
    }
    const body = html.slice(cursor, bodyEnd);
    if (name === "style") styleParts.push(body);
    else scriptParts.push(body);
    index = resumeAt;
  }

  return {
    tags,
    attributes,
    styleText: styleParts.join("\n"),
    scriptText: scriptParts.join("\n"),
  };
}

/**
 * Read an attribute's value, starting at the character after its name.
 *
 * Returns `undefined` for a valueless attribute (`disabled`, `hidden`), and
 * handles both quote styles plus the unquoted form.
 */
function readAttributeValue(html: string, from: number): string | undefined {
  let index = from;
  while (index < html.length && isSpace(html[index])) index += 1;
  if (html[index] !== "=") return undefined;
  index += 1;
  while (index < html.length && isSpace(html[index])) index += 1;

  const quote = html[index];
  if (quote === '"' || quote === "'") {
    const end = html.indexOf(quote, index + 1);
    return end === -1 ? undefined : html.slice(index + 1, end);
  }
  const start = index;
  while (index < html.length && !isSpace(html[index]) && html[index] !== ">") {
    index += 1;
  }
  return index > start ? html.slice(start, index) : undefined;
}

/** Whether the markup contains any element a user can interact with. */
export function hasInteractiveElement(scanned: ScannedHtml): boolean {
  return (
    scanned.tags.has("button") ||
    scanned.tags.has("a") ||
    scanned.tags.has("input") ||
    scanned.tags.has("select") ||
    scanned.tags.has("textarea")
  );
}

/** Whether any element carries an ARIA attribute or an explicit role. */
export function hasAccessibilityAffordance(scanned: ScannedHtml): boolean {
  if (scanned.attributes.has("role")) return true;
  for (const attribute of scanned.attributes) {
    if (attribute.startsWith("aria-")) return true;
  }
  return false;
}
