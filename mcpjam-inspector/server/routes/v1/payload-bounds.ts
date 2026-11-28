/**
 * Shortening a JSON payload without breaking it.
 *
 * The agent Playground hands raw tool arguments, tool results and transcript
 * messages to callers that pay per token, so every value it returns has a
 * ceiling. Meeting that ceiling by slicing the serialized text returned a
 * string that was no longer JSON: a tool result's `isError`, and every field
 * after the cut, could only be read by parsing a broken document. Here the cut
 * happens INSIDE the value, so it keeps its JSON type and every field that
 * survives is still a field.
 *
 * A value is first PREPARED:
 *
 *   - `$`-prefixed keys and `_meta` are dropped. They are transport and
 *     protocol annotations, never the caller's data, and the tool-snapshot
 *     producer strips the same keys before persistence.
 *   - A bigint becomes its decimal string (`JSON.stringify` throws on one).
 *     Functions and symbols are dropped.
 *   - Nesting deeper than MAX_DEPTH, and a circular reference, become marker
 *     strings, so a cyclic or pathologically deep value cannot stall a
 *     response.
 *   - With a scrubber, every string and key has its secrets replaced. That
 *     happens before anything is cut, so a cut can only land inside
 *     `[secret:NAME]`, never partway through a credential.
 *
 * Then, when the JSON is longer than the ceiling, the value is SHORTENED. Each
 * step runs only when the one before it cannot fit:
 *
 *   1. Strings. The longest per-string length that fits, and keeps at least
 *      MIN_STRING_CHARS, is binary-searched, and every longer string keeps that
 *      much and ends in `…[+N chars]`.
 *   2. Arrays, with strings whole. Every array longer than the largest item
 *      count that fits, at least one, keeps its first items and ends in an
 *      `…[+N items]` item.
 *   3. Both. Strings keep half the length they could have if every array were
 *      emptied, and arrays keep as many items as fit beside them.
 *   4. Objects, as a last resort, when keys alone are over the ceiling: an
 *      object keeps its first entries, with strings and arrays whole if any
 *      entry fits that way, and cut to their markers if not. It gets no marker
 *      entry, because any key would be one the payload never had.
 *
 * Every cut is listed in `truncatedFields` with its path and reason. A
 * shortened value an agent believes is complete sends it debugging the wrong
 * thing, so nothing is cut without saying so.
 */

import type { SecretScrubber } from "../../utils/secrets/secret-scrubber";

/** Nesting beyond this is replaced by a marker rather than recursed into. */
const MAX_DEPTH = 8;

/** A JSON value, as a bounded payload holds it. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** One place a bounded value holds less than the payload did. */
export interface TruncatedField {
  /**
   * JSONPath-like, from the bounded value: `parts[1].response.content[0].text`
   * or `["a b"]`, and empty for the value itself. `underField` roots it at the
   * field a public record holds the value in.
   */
  path: string;
  /**
   * `length`: a string was shortened. `items`: an array (or, as a last
   * resort, an object) kept only its first items. `depth`: nesting, or a
   * circular reference, was replaced by a marker string.
   */
  reason: "length" | "items" | "depth";
  /** The string's length, or the item count, before the cut. */
  originalLength?: number;
}

export interface BoundedJson {
  /** The prepared value, shortened when its JSON was over the ceiling. */
  value: JsonValue | undefined;
  /** Whether anything was cut; `truncatedFields` then says what. */
  truncated: boolean;
  truncatedFields: TruncatedField[];
}

/** Content that preparation cut. Its marker is printed in its place. */
class Cut {
  constructor(readonly marker: string) {}
}

const DEPTH_CUT = new Cut("[truncated: max depth]");
const CIRCULAR_CUT = new Cut("[truncated: circular reference]");

/** A prepared value. Objects are Maps, so a `__proto__` key is plain data. */
type Prepared =
  null | boolean | number | string | Cut | Prepared[] | Map<string, Prepared>;

function isDroppedKey(key: string): boolean {
  return key.startsWith("$") || key === "_meta";
}

/**
 * Copy a JSON-ish value into the prepared tree.
 *
 * `undefined`, functions and symbols come back `undefined`, which drops them
 * from an object; an array holds `null` there instead, as JSON does.
 */
function prepare(
  value: unknown,
  scrub: (text: string) => string,
  depth: number,
  ancestors: Set<object>,
): Prepared | undefined {
  if (typeof value === "string") return scrub(value);
  if (typeof value === "bigint") return scrub(value.toString());
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value !== "object") return undefined;
  if (depth >= MAX_DEPTH) return DEPTH_CUT;
  if (ancestors.has(value)) return CIRCULAR_CUT;
  ancestors.add(value);
  let prepared: Prepared;
  if (Array.isArray(value)) {
    prepared = Array.from(
      value,
      (item: unknown) => prepare(item, scrub, depth + 1, ancestors) ?? null,
    );
  } else {
    const entries = new Map<string, Prepared>();
    for (const [key, item] of Object.entries(value)) {
      if (isDroppedKey(key)) continue;
      const child = prepare(item, scrub, depth + 1, ancestors);
      if (child !== undefined) entries.set(scrub(key), child);
    }
    prepared = entries;
  }
  ancestors.delete(value);
  return prepared;
}

/** How much of each shape a print keeps. Infinity keeps it whole. */
interface Caps {
  /** Characters a string keeps. */
  chars: number;
  /** Items an array keeps. */
  items: number;
  /** Entries an object keeps. */
  entries: number;
}

const WHOLE: Caps = { chars: Infinity, items: Infinity, entries: Infinity };

/**
 * The least a string keeps while strings are shortened on their own. Below
 * this, a long array of short strings would be cut into markers longer than
 * what each kept, where keeping whole items says more.
 */
const MIN_STRING_CHARS = 100;

function lengthMarker(removed: number): string {
  return `…[+${removed} chars]`;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * How many characters of `text` a cap keeps: all of them, unless cutting
 * leaves the string shorter with its marker. Never half a surrogate pair,
 * which would print as an escape rather than a character.
 */
function keptLength(text: string, cap: number): number {
  if (text.length <= cap) return text.length;
  const kept =
    cap > 0 && isHighSurrogate(text.charCodeAt(cap - 1)) ? cap - 1 : cap;
  return kept + lengthMarker(text.length - kept).length < text.length
    ? kept
    : text.length;
}

/** A key reads as `.key` when it is an identifier, `["key"]` otherwise. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function keyPath(parent: string, key: string): string {
  if (!IDENTIFIER.test(key)) return `${parent}[${JSON.stringify(key)}]`;
  return parent === "" ? key : `${parent}.${key}`;
}

/** `fields` with each path read from the field `prefix` holds the value in. */
export function underField(
  prefix: string,
  fields: readonly TruncatedField[],
): TruncatedField[] {
  return fields.map((field) => ({
    ...field,
    path:
      field.path === "" || field.path.startsWith("[")
        ? `${prefix}${field.path}`
        : `${prefix}.${field.path}`,
  }));
}

/**
 * Prints a prepared tree as JSON values under `caps`, counting the JSON length
 * as it goes. The count matches `JSON.stringify` of the result, and printing
 * stops descending once the budget is spent, so trying a cap costs about the
 * ceiling rather than the whole payload.
 */
class Printer {
  /** Characters left in the budget; negative once the print cannot fit. */
  left: number;

  constructor(
    private readonly caps: Caps,
    budget: number,
    /** Where cuts are recorded. Omitted while only checking a fit. */
    private readonly cuts?: TruncatedField[],
  ) {
    this.left = budget;
  }

  print(node: Prepared, path: string): JsonValue {
    if (this.left < 0) return null;
    if (node instanceof Cut) {
      this.cuts?.push({ path, reason: "depth" });
      return this.spendString(node.marker);
    }
    if (typeof node === "string") return this.printString(node, path);
    if (Array.isArray(node)) return this.printArray(node, path);
    if (node instanceof Map) return this.printObject(node, path);
    this.left -= JSON.stringify(node).length;
    return node;
  }

  private printString(text: string, path: string): string {
    const kept = keptLength(text, this.caps.chars);
    if (kept === text.length) return this.spendString(text);
    this.cuts?.push({ path, reason: "length", originalLength: text.length });
    return this.spendString(
      `${text.slice(0, kept)}${lengthMarker(text.length - kept)}`,
    );
  }

  private printArray(items: readonly Prepared[], path: string): JsonValue[] {
    const kept = Math.min(items.length, this.caps.items);
    if (kept < items.length) {
      this.cuts?.push({ path, reason: "items", originalLength: items.length });
    }
    this.left -= 2;
    const out: JsonValue[] = [];
    for (const [index, item] of items.entries()) {
      if (index === kept || this.left < 0) break;
      if (index > 0) this.left -= 1;
      out.push(this.print(item, `${path}[${index}]`));
    }
    if (kept < items.length) {
      if (kept > 0) this.left -= 1;
      out.push(this.spendString(`…[+${items.length - kept} items]`));
    }
    return out;
  }

  private printObject(
    entries: ReadonlyMap<string, Prepared>,
    path: string,
  ): { [key: string]: JsonValue } {
    const kept = Math.min(entries.size, this.caps.entries);
    if (kept < entries.size) {
      this.cuts?.push({ path, reason: "items", originalLength: entries.size });
    }
    this.left -= 2;
    const out: { [key: string]: JsonValue } = {};
    let index = 0;
    for (const [key, item] of entries) {
      if (index === kept || this.left < 0) break;
      if (index > 0) this.left -= 1;
      this.spendString(key);
      this.left -= 1;
      // `defineProperty`, not assignment: an own `__proto__` key is legal
      // JSON, and assignment would hand it to the prototype setter instead.
      Object.defineProperty(out, key, {
        value: this.print(item, keyPath(path, key)),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      index += 1;
    }
    return out;
  }

  /** Spend a string's JSON length, without encoding one that cannot fit. */
  private spendString(text: string): string {
    // The raw length plus its quotes is a floor on the JSON length.
    if (text.length + 2 > this.left) this.left = -1;
    else this.left -= JSON.stringify(text).length;
    return text;
  }
}

/** The largest n in [low, high] that `fitsAt` accepts, given that low does. */
function raise(
  low: number,
  high: number,
  fitsAt: (n: number) => boolean,
): number {
  let best = low;
  let top = high;
  while (best < top) {
    const mid = best + Math.ceil((top - best) / 2);
    if (fitsAt(mid)) best = mid;
    else top = mid - 1;
  }
  return best;
}

/**
 * The caps that shorten a value to fit, in the order the header describes.
 * Each search starts from a cap already printed within the budget, so the
 * result fits, unless even the last resort's bare markers do not.
 */
function chooseCaps(fits: (caps: Caps) => boolean, ceiling: number): Caps {
  /** `make` of the largest n from `low` that fits, or null if `low` fails. */
  const largestFrom = (low: number, make: (n: number) => Caps): Caps | null =>
    fits(make(low)) ? make(raise(low, ceiling, (n) => fits(make(n)))) : null;

  const strings = largestFrom(MIN_STRING_CHARS, (chars) => ({
    ...WHOLE,
    chars,
  }));
  if (strings) return strings;
  const arrays = largestFrom(1, (items) => ({ ...WHOLE, items }));
  if (arrays) return arrays;
  const roomiest = largestFrom(0, (chars) => ({ ...WHOLE, chars, items: 0 }));
  if (roomiest) {
    const half = Math.floor(roomiest.chars / 2);
    const items = raise(0, ceiling, (n) =>
      fits({ ...WHOLE, chars: half, items: n }),
    );
    const chars = raise(half, ceiling, (n) =>
      fits({ ...WHOLE, chars: n, items }),
    );
    return { ...WHOLE, chars, items };
  }
  const objects = largestFrom(1, (entries) => ({ ...WHOLE, entries }));
  if (objects) return objects;
  const bare = largestFrom(0, (entries) => ({ chars: 0, items: 0, entries }));
  if (!bare) return { chars: 0, items: 0, entries: 0 };
  const { entries } = bare;
  const items = raise(0, ceiling, (n) => fits({ chars: 0, items: n, entries }));
  const chars = raise(0, ceiling, (n) => fits({ chars: n, items, entries }));
  return { chars, items, entries };
}

/**
 * Prepare `value` and shorten it until its JSON is at most `maxChars` long.
 *
 * A value that already fits comes back whole. Either way it keeps the input's
 * JSON type: an object is still an object, and its other fields still parse.
 */
export function boundJson(
  value: unknown,
  maxChars: number,
  scrubber?: SecretScrubber,
): BoundedJson {
  const scrub = scrubber
    ? (text: string) => scrubber.scrubString(text)
    : (text: string) => text;
  const root = prepare(value, scrub, 0, new Set());
  if (root === undefined) {
    return { value: undefined, truncated: false, truncatedFields: [] };
  }
  const fits = (caps: Caps): boolean => {
    const trial = new Printer(caps, maxChars);
    trial.print(root, "");
    return trial.left >= 0;
  };
  const caps = fits(WHOLE) ? WHOLE : chooseCaps(fits, maxChars);
  const truncatedFields: TruncatedField[] = [];
  const bounded = new Printer(caps, Infinity, truncatedFields).print(root, "");
  return {
    value: bounded,
    truncated: truncatedFields.length > 0,
    truncatedFields,
  };
}
