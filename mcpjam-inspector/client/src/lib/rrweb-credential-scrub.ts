/**
 * Credentials out of recorded rrweb events at both final serializers:
 * the PostHog relay and Sentry Replay's transport
 * (`sentry-recording-filter.ts`).
 */
import {
  scrubCredentialsInText,
  scrubTelemetryValue,
} from "../../../shared/credential-urls";

/**
 * rrweb event types a recording may carry. 0 and 1 (DOM loaded, load) carry
 * nothing. 4 (meta: the page URL), 5 (custom: PostHog's `$url_changed`,
 * Sentry's breadcrumbs and spans) and 6 (plugins: console logs and network
 * requests) are walked whole. 2 (full snapshot) and 3 (incremental) are DOM:
 * masked at capture by the replay profile's text, attribute and network
 * callbacks, except stylesheet text, which rrweb hands to none of them. That
 * is scrubbed here (`scrubDomEvent`): a credential URL in a `<style>` is a
 * credential like any other.
 */
const SNAPSHOT_PASSIVE_EVENT_TYPES = new Set([0, 1]);
const SNAPSHOT_DOM_EVENT_TYPES = new Set([2, 3]);
const SNAPSHOT_WALKED_EVENT_TYPES = new Set([4, 5, 6]);

/** rrweb's `NodeType.Text`. */
const RRWEB_TEXT_NODE = 3;
/** rrweb's `IncrementalSource` values that carry stylesheet text. */
const RRWEB_SOURCE = {
  mutation: 0,
  styleSheetRule: 8,
  font: 10,
  styleDeclaration: 13,
  adoptedStyleSheet: 15,
} as const;
/**
 * Attributes rrweb fills with CSS: a `<link>` stylesheet it inlined
 * (`_cssText`) and the `style` attribute, which it absolutifies before any
 * masking callback runs.
 */
const RRWEB_STYLE_ATTRIBUTES = new Set(["_cssText", "style"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `record` with `key` set to `next(record[key])`. The same object when
 * nothing changed, a shallow copy otherwise: rrweb's mirror holds the
 * serialized nodes it emitted, so they are never edited in place.
 */
function withField(
  record: Record<string, unknown>,
  key: string,
  next: (value: unknown) => unknown,
): Record<string, unknown> {
  if (!(key in record)) return record;
  const value = next(record[key]);
  return value === record[key] ? record : { ...record, [key]: value };
}

/** `items` mapped; the same array when no item changed. */
function mapItems(items: unknown, next: (item: unknown) => unknown): unknown {
  if (!Array.isArray(items)) return items;
  let out: unknown[] | null = null;
  items.forEach((item, index) => {
    const value = next(item);
    if (value !== item) {
      out ??= items.slice();
      out[index] = value;
    }
  });
  return out ?? items;
}

function scrubCss(value: unknown): unknown {
  return typeof value === "string" ? scrubCredentialsInText(value) : value;
}

/** A `style` attribute's change: a string, or rrweb's per-property diff. */
function scrubStyleValue(value: unknown): unknown {
  if (typeof value === "string") return scrubCss(value);
  if (!isPlainRecord(value)) return value;
  let out = value;
  for (const property of Object.keys(value)) {
    out = withField(out, property, (entry) =>
      Array.isArray(entry) ? mapItems(entry, scrubCss) : scrubCss(entry),
    );
  }
  return out;
}

function scrubStyleAttributes(attributes: unknown): unknown {
  if (!isPlainRecord(attributes)) return attributes;
  let out = attributes;
  for (const name of RRWEB_STYLE_ATTRIBUTES) {
    out = withField(out, name, scrubStyleValue);
  }
  return out;
}

/** A serialized DOM node (rrweb-snapshot) and its subtree. */
function scrubSerializedNode(node: unknown): unknown {
  if (!isPlainRecord(node)) return node;
  let out = node;
  if (node.type === RRWEB_TEXT_NODE && node.isStyle === true) {
    out = withField(out, "textContent", scrubCss);
  }
  out = withField(out, "attributes", scrubStyleAttributes);
  return withField(out, "childNodes", (children) =>
    mapItems(children, scrubSerializedNode),
  );
}

/** `rules: [{ rule, index }]` (CSSOM insertions). */
function scrubRules(rules: unknown): unknown {
  return mapItems(rules, (entry) =>
    isPlainRecord(entry) ? withField(entry, "rule", scrubCss) : entry,
  );
}

function scrubIncrementalData(data: Record<string, unknown>): unknown {
  switch (data.source) {
    case RRWEB_SOURCE.mutation: {
      let out = withField(data, "adds", (adds) =>
        mapItems(adds, (add) =>
          isPlainRecord(add)
            ? withField(add, "node", scrubSerializedNode)
            : add,
        ),
      );
      // Text changes reach `maskTextFn`, a `<style>`'s included; once more
      // here is idempotent and keeps this pass the one guarantee.
      out = withField(out, "texts", (texts) =>
        mapItems(texts, (text) =>
          isPlainRecord(text) ? withField(text, "value", scrubCss) : text,
        ),
      );
      return withField(out, "attributes", (changes) =>
        mapItems(changes, (change) =>
          isPlainRecord(change)
            ? withField(change, "attributes", scrubStyleAttributes)
            : change,
        ),
      );
    }
    case RRWEB_SOURCE.styleSheetRule: {
      let out = withField(data, "adds", scrubRules);
      out = withField(out, "replace", scrubCss);
      return withField(out, "replaceSync", scrubCss);
    }
    case RRWEB_SOURCE.styleDeclaration:
      return withField(data, "set", (set) =>
        isPlainRecord(set) ? withField(set, "value", scrubCss) : set,
      );
    case RRWEB_SOURCE.adoptedStyleSheet:
      return withField(data, "styles", (styles) =>
        mapItems(styles, (style) =>
          isPlainRecord(style) ? withField(style, "rules", scrubRules) : style,
        ),
      );
    case RRWEB_SOURCE.font:
      return withField(data, "fontSource", scrubCss);
    default:
      return data;
  }
}

/**
 * A full snapshot or incremental event with its stylesheet text scrubbed.
 * `null` when it cannot be read: posthog-js packs a compressed event's DOM
 * into gzip strings (`cv`), which cannot be scrubbed without corrupting them.
 * Both replay profiles turn that packing off (`compress_events: false`), so
 * one arriving packed is a shape this does not understand.
 */
function scrubDomEvent(event: Record<string, unknown>): unknown {
  if ("cv" in event || !isPlainRecord(event.data)) return null;
  if (event.type === 2) {
    return withField(event, "data", (data) =>
      withField(data as Record<string, unknown>, "node", scrubSerializedNode),
    );
  }
  return withField(event, "data", (data) =>
    scrubIncrementalData(data as Record<string, unknown>),
  );
}

/**
 * A list of rrweb events (a PostHog `$snapshot` batch, a Sentry replay
 * recording segment) with every credential out of it. `null` when the list
 * is not in a shape this understands: fail closed, the caller drops it.
 */
export function scrubRrwebCredentials(data: unknown): unknown[] | null {
  if (!Array.isArray(data)) return null;
  const out: unknown[] = [];
  for (const item of data) {
    if (!isPlainRecord(item)) return null;
    const type = item.type;
    if (typeof type !== "number") return null;
    if (SNAPSHOT_PASSIVE_EVENT_TYPES.has(type)) {
      out.push(item);
    } else if (SNAPSHOT_DOM_EVENT_TYPES.has(type)) {
      const scrubbed = scrubDomEvent(item);
      if (scrubbed === null) return null;
      out.push(scrubbed);
    } else if (SNAPSHOT_WALKED_EVENT_TYPES.has(type)) {
      out.push(scrubTelemetryValue(item));
    } else {
      return null;
    }
  }
  return out;
}
