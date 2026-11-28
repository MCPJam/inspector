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
 * A value is first PREPARED (`payload-prepare.ts`): protocol annotations are
 * dropped, deep or circular nesting becomes a marker, and with a scrubber
 * every string and key has its secrets replaced, all before anything is cut.
 *
 * Then, when the JSON is longer than the ceiling, the value is SHORTENED. Each
 * step runs only when the one before it cannot fit:
 *
 *   1. Strings. The longest per-string length that fits, and keeps at least
 *      MIN_STRING_CHARS, is binary-searched, and every longer string keeps that
 *      much and ends in `…[+N chars]`, unless that would not leave it shorter
 *      with its entry in the list.
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
 * thing, so nothing is cut without saying so. The list counts against the
 * ceiling too: each entry is spent from the same budget as the value, since a
 * path repeats every key above it and hundreds of cuts beneath one long key
 * could outweigh the value. Where the entries for cuts beneath a node would
 * not fit, the node or one above it is cut instead, and one entry reports it.
 */

import type { SecretScrubber } from "../../utils/secrets/secret-scrubber";
import { Cut, prepare, type Prepared } from "./payload-prepare";

/** A JSON value, as a bounded payload holds it. */
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** One place a bounded value holds less than the payload did. */
export interface TruncatedField {
  /**
   * JSONPath-like, from the bounded value: `parts[1].response.content[0].text`
   * or `["a b"]`, and empty for the value itself. With `boundJson`'s `field`,
   * it starts at the field a public record holds the value in instead.
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
 * How many characters of `text`, longer than `cap`, the cap keeps: all of
 * them, unless cutting leaves the string shorter with its marker and its
 * `entry` in the list, a comma and the list's brackets included. Never half a
 * surrogate pair, which would print as an escape rather than a character.
 */
function keptLength(text: string, cap: number, entry: number): number {
  const kept =
    cap > 0 && isHighSurrogate(text.charCodeAt(cap - 1)) ? cap - 1 : cap;
  const cut = kept + lengthMarker(text.length - kept).length + entry + 2;
  return cut < text.length ? kept : text.length;
}

/** A key reads as `.key` when it is an identifier, `["key"]` otherwise. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function keyPath(parent: string, key: string): string {
  if (!IDENTIFIER.test(key)) return `${parent}[${JSON.stringify(key)}]`;
  return parent === "" ? key : `${parent}.${key}`;
}

/**
 * Prints a prepared tree as JSON values under `caps`, counting the JSON length
 * of the result and of its cut list as it goes. The count matches
 * `JSON.stringify` of both, and printing stops descending once the budget is
 * spent, so trying a cap costs about the ceiling rather than the whole payload.
 */
class Printer {
  /** Characters left in the budget; negative once the print cannot fit. */
  left: number;
  /** Whether a cut has been listed, so the list's brackets are paid for. */
  private listed = false;

  constructor(
    private readonly caps: Caps,
    budget: number,
    /** Where cuts are recorded. Omitted while only checking a fit. */
    private readonly cuts?: TruncatedField[],
    /** Cut arrays print no marker and list nothing: a floor on the cost. */
    private readonly free = false,
  ) {
    this.left = budget;
  }

  print(node: Prepared, path: string): JsonValue {
    if (this.left < 0) return null;
    if (node instanceof Cut) {
      this.cut({ path, reason: "depth" });
      return this.spendString(node.marker);
    }
    if (typeof node === "string") return this.printString(node, path);
    if (Array.isArray(node)) return this.printArray(node, path);
    if (node instanceof Map) return this.printObject(node, path);
    this.left -= JSON.stringify(node).length;
    return node;
  }

  private printString(text: string, path: string): string {
    if (text.length <= this.caps.chars) return this.spendString(text);
    const field: TruncatedField = {
      path,
      reason: "length",
      originalLength: text.length,
    };
    const entry = JSON.stringify(field).length;
    const kept = keptLength(text, this.caps.chars, entry);
    if (kept === text.length) return this.spendString(text);
    this.cut(field);
    return this.spendString(
      `${text.slice(0, kept)}${lengthMarker(text.length - kept)}`,
    );
  }

  private printArray(items: readonly Prepared[], path: string): JsonValue[] {
    const kept = Math.min(items.length, this.caps.items);
    const marked = kept < items.length && !this.free;
    if (marked) {
      this.cut({ path, reason: "items", originalLength: items.length });
    }
    this.left -= 2;
    const out: JsonValue[] = [];
    for (const [index, item] of items.entries()) {
      if (index === kept || this.left < 0) break;
      if (index > 0) this.left -= 1;
      out.push(this.print(item, `${path}[${index}]`));
    }
    if (marked) {
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
      this.cut({ path, reason: "items", originalLength: entries.size });
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

  /** Record a cut, and spend its entry in the list with a comma or brackets. */
  private cut(field: TruncatedField): void {
    this.cuts?.push(field);
    if (field.path.length + 2 > this.left) this.left = -1;
    else this.left -= JSON.stringify(field).length + (this.listed ? 1 : 2);
    this.listed = true;
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
 * The largest item cap in [low, high] that fits, or null. With `free`,
 * `fitsAt` prints cut arrays without their markers and entries.
 *
 * A higher cap prints longer, except at an array's length: that array becomes
 * whole and drops its marker and entry, which can outweigh the item it gains
 * (`[0,0]` is shorter than `[0,"…[+1 items]"]`). So a cap that does not fit
 * rules out the caps above it only up to the next length, and each run, from
 * `low` or from a length, is tried from the top down. Without markers and
 * entries a print only lengthens as the cap rises, so no cap above the last
 * that fits that way can fit, and the search ends there.
 */
function raiseItems(
  low: number,
  high: number,
  fitsAt: (n: number, free?: boolean) => boolean,
  lengths: readonly number[],
): number | null {
  const fitsFree = (n: number): boolean => fitsAt(n, true);
  if (!fitsFree(low)) return null;
  let end = raise(low, high, fitsFree);
  const starts = [low, ...lengths.filter((n) => n > low && n <= end)];
  for (const start of starts.reverse()) {
    if (fitsAt(start)) return raise(start, end, fitsAt);
    end = start - 1;
  }
  return null;
}

/** Each array length in the tree, ascending: the caps where one is whole. */
function arrayLengths(root: Prepared): number[] {
  const lengths = new Set<number>();
  const visit = (node: Prepared): void => {
    if (node instanceof Map) {
      node.forEach(visit);
    } else if (Array.isArray(node)) {
      lengths.add(node.length);
      node.forEach(visit);
    }
  };
  visit(root);
  return [...lengths].sort((a, b) => a - b);
}

/**
 * The caps that shorten a value to fit, in the order the header describes.
 * Each search starts from a cap already printed within the budget, so the
 * result fits, unless even the last resort's bare markers do not.
 */
function chooseCaps(
  fits: (caps: Caps, free?: boolean) => boolean,
  ceiling: number,
  lengths: readonly number[],
): Caps {
  /** `make` of the largest n from `low` that fits, or null if `low` fails. */
  const largestFrom = (low: number, make: (n: number) => Caps): Caps | null =>
    fits(make(low)) ? make(raise(low, ceiling, (n) => fits(make(n)))) : null;
  /** The most items each array keeps beside `caps`, at least `low`. */
  const mostItems = (caps: Caps, low: number): number | null =>
    raiseItems(
      low,
      ceiling,
      (items, free) => fits({ ...caps, items }, free),
      lengths,
    );

  const strings = largestFrom(MIN_STRING_CHARS, (chars) => ({
    ...WHOLE,
    chars,
  }));
  if (strings) return strings;
  const arrays = mostItems(WHOLE, 1);
  if (arrays !== null) return { ...WHOLE, items: arrays };
  const roomiest = largestFrom(0, (chars) => ({ ...WHOLE, chars, items: 0 }));
  if (roomiest) {
    const half = Math.floor(roomiest.chars / 2);
    // `half` fits with no items, as `roomiest.chars` did, so never null.
    const items = mostItems({ ...WHOLE, chars: half }, 0) ?? 0;
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
  // `bare` fits with no items, so never null.
  const items = mostItems(bare, 0) ?? 0;
  const chars = raise(0, ceiling, (n) => fits({ chars: n, items, entries }));
  return { chars, items, entries };
}

/**
 * Prepare `value` and shorten it until its JSON and its `truncatedFields`
 * together are at most `maxChars` long.
 *
 * A value that already fits comes back whole. Either way it keeps the input's
 * JSON type: an object is still an object, and its other fields still parse.
 * `field` is where a public record holds the value: paths start there, and are
 * counted as they will be published.
 */
export function boundJson(
  value: unknown,
  maxChars: number,
  options: { scrubber?: SecretScrubber; field?: string } = {},
): BoundedJson {
  const { scrubber, field = "" } = options;
  const scrub = scrubber
    ? (text: string) => scrubber.scrubString(text)
    : (text: string) => text;
  const root = prepare(value, scrub, 0, new Set());
  if (root === undefined) {
    return { value: undefined, truncated: false, truncatedFields: [] };
  }
  const fits = (caps: Caps, free = false): boolean => {
    const trial = new Printer(caps, maxChars, undefined, free);
    trial.print(root, field);
    return trial.left >= 0;
  };
  const caps = fits(WHOLE)
    ? WHOLE
    : chooseCaps(fits, maxChars, arrayLengths(root));
  const truncatedFields: TruncatedField[] = [];
  const bounded = new Printer(caps, Infinity, truncatedFields).print(
    root,
    field,
  );
  return {
    value: bounded,
    truncated: truncatedFields.length > 0,
    truncatedFields,
  };
}
