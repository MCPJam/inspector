/**
 * Preparing a payload for `boundJson` (`payload-bounds.ts`): a copy that
 * printing can measure and shorten without ever throwing.
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
 */

/** Nesting beyond this is replaced by a marker rather than recursed into. */
const MAX_DEPTH = 8;

/** Content that preparation cut. Its marker is printed in its place. */
export class Cut {
  constructor(readonly marker: string) {}
}

const DEPTH_CUT = new Cut("[truncated: max depth]");
const CIRCULAR_CUT = new Cut("[truncated: circular reference]");

/** A prepared value. Objects are Maps, so a `__proto__` key is plain data. */
export type Prepared =
  null | boolean | number | string | Cut | Prepared[] | Map<string, Prepared>;

function isDroppedKey(key: string): boolean {
  return key.startsWith("$") || key === "_meta";
}

/**
 * An object's entries under scrubbed keys.
 *
 * Scrubbing can land two keys on one name: a literal `[secret:NAME]` key
 * beside one holding NAME's value, or two keys holding different escaped
 * forms of it. A Map would silently keep only one of them. Keys scrubbing
 * leaves alone keep their names, and a changed key that collides takes `#2`,
 * `#3`, … after its scrubbed form, which still shows nothing of the original.
 */
function scrubKeys(
  entries: readonly (readonly [string, Prepared])[],
  scrub: (text: string) => string,
): Map<string, Prepared> {
  const scrubbed = entries.map(
    ([key, item]) => [key, scrub(key), item] as const,
  );
  const taken = new Set(
    scrubbed.filter(([key, safe]) => key === safe).map(([key]) => key),
  );
  const out = new Map<string, Prepared>();
  for (const [key, safe, item] of scrubbed) {
    let name = safe;
    for (let n = 2; safe !== key && taken.has(name); n += 1) {
      name = `${safe}#${n}`;
    }
    taken.add(name);
    out.set(name, item);
  }
  return out;
}

/**
 * Copy a JSON-ish value into the prepared tree.
 *
 * `undefined`, functions and symbols come back `undefined`, which drops them
 * from an object; an array holds `null` there instead, as JSON does.
 */
export function prepare(
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
    const entries: [string, Prepared][] = [];
    for (const [key, item] of Object.entries(value)) {
      if (isDroppedKey(key)) continue;
      const child = prepare(item, scrub, depth + 1, ancestors);
      if (child !== undefined) entries.push([key, child]);
    }
    prepared = scrubKeys(entries, scrub);
  }
  ancestors.delete(value);
  return prepared;
}
