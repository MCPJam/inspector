/**
 * The fail-closed walker: `scrubTelemetryValue` scrubs a whole JSON-ish
 * value, keys included, and `scrubTelemetryEvent` falls back to dropping the
 * URL-bearing fields, then the event, when the walk cannot finish.
 */
import { scrubCredentialsInText } from "./scrub.ts";

/** Deeper or larger than this is not a telemetry payload; refuse it. */
const WALK_MAX_DEPTH = 64;
const WALK_MAX_NODES = 200_000;

export class TelemetryScrubError extends Error {
  constructor(reason: string) {
    super(`telemetry scrub failed: ${reason}`);
    this.name = "TelemetryScrubError";
  }
}

export interface ScrubTelemetryOptions {
  /**
   * Keys whose values are left alone at the TOP level of the value — e.g.
   * PostHog's `token` property, which is the project key and must reach
   * ingestion as is.
   */
  preserveTopLevelKeys?: readonly string[];
}

/**
 * Scrub every credential out of a JSON-ish value: every string (URL or
 * prose) and every object KEY (heatmap data is keyed by URL). The input is
 * never mutated: whatever changed is copied, and a value with nothing to
 * scrub comes back as the same object. Non-plain objects (Dates, typed
 * arrays) pass through.
 *
 * THROWS `TelemetryScrubError` on a cycle, excessive depth, or excessive size
 * — the one function here that does, because its callers must know the value
 * is not clean. Use `scrubTelemetryEvent` for the fail-closed wrapper.
 */
export function scrubTelemetryValue<T>(
  value: T,
  options: ScrubTelemetryOptions = {},
): T {
  const preserve = new Set(options.preserveTopLevelKeys ?? []);
  const seen = new Set<object>();
  let nodes = 0;
  const walk = (node: unknown, depth: number): unknown => {
    if (++nodes > WALK_MAX_NODES) throw new TelemetryScrubError("too large");
    if (typeof node === "string") return scrubCredentialsInText(node);
    if (node === null || typeof node !== "object") return node;
    if (depth > WALK_MAX_DEPTH) throw new TelemetryScrubError("too deep");
    if (seen.has(node)) throw new TelemetryScrubError("cycle");
    seen.add(node);
    try {
      // Copy on write: a value with nothing to scrub comes back as the very
      // same object, so callers that check identity — and the cost of the
      // common case — are unaffected.
      if (Array.isArray(node)) {
        let changed = false;
        const out = node.map((item) => {
          const next = walk(item, depth + 1);
          if (next !== item) changed = true;
          return next;
        });
        return changed ? out : node;
      }
      const proto = Object.getPrototypeOf(node);
      if (proto !== Object.prototype && proto !== null) return node;
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        const cleanKey = scrubCredentialsInText(key);
        const next =
          depth === 0 && preserve.has(key) ? child : walk(child, depth + 1);
        if (cleanKey !== key || next !== child) changed = true;
        // Two keys that differ only in their secret (`$$heatmap` data keyed
        // by `/results/a` and `/results/b`) scrub to the same key. Lists are
        // merged; anything else keeps both under a numbered key rather than
        // letting the later silently overwrite the earlier.
        let targetKey = cleanKey;
        let value = next;
        if (Object.prototype.hasOwnProperty.call(out, cleanKey)) {
          const existing = out[cleanKey];
          if (Array.isArray(existing) && Array.isArray(next)) {
            value = [...existing, ...next];
          } else {
            let n = 2;
            while (
              Object.prototype.hasOwnProperty.call(out, `${cleanKey}#${n}`)
            ) {
              n++;
            }
            targetKey = `${cleanKey}#${n}`;
          }
        }
        // Defined, not assigned: a JSON key named `__proto__` must stay a
        // key, not become the copy's prototype.
        Object.defineProperty(out, targetKey, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return changed ? out : node;
    } finally {
      seen.delete(node);
    }
  };
  return walk(value, 0) as T;
}

/**
 * The PostHog event properties whose value is a URL or a path. One list for
 * the client's name masking, the walker's fail-closed strip and the leak
 * monitor.
 */
export const POSTHOG_URL_PROPERTIES = [
  "$current_url",
  "$referrer",
  "$pathname",
  "$external_click_url",
  "$session_entry_url",
  "$session_entry_pathname",
  "$session_entry_referrer",
  "$initial_current_url",
  "$initial_pathname",
  "$initial_referrer",
  "$prev_pageview_url",
  "$prev_pageview_pathname",
] as const;

/**
 * Fields that hold a URL or a path on the events our sinks send. When the
 * walker cannot finish, these are deleted so what remains carries no URL.
 */
export const URL_BEARING_FIELDS: readonly string[] = [
  // PostHog
  ...POSTHOG_URL_PROPERTIES,
  "$referring_domain",
  "$host",
  "$elements_chain",
  "$elements",
  "$exception_list",
  "$heatmap_data",
  "$$heatmap",
  "$web_vitals_LCP_event",
  "$web_vitals_CLS_event",
  "$web_vitals_FCP_event",
  "$web_vitals_INP_event",
  "$snapshot_data",
  "failed_request",
  // Sentry
  "request",
  "breadcrumbs",
  "transaction",
  "spans",
  "exception",
  "message",
  "logentry",
  "urls",
  "url",
  "contexts",
  "extra",
];

/**
 * Fail closed: scrub `event`; if the walker cannot finish, delete every
 * URL-bearing field (at the top level and one level down, where PostHog keeps
 * `properties`) and scrub the rest; if THAT fails, return `null` so the
 * caller drops the event. Never throws.
 */
export function scrubTelemetryEvent<T extends object>(
  event: T,
  options: ScrubTelemetryOptions & {
    onFallback?: (reason: string) => void;
  } = {},
): T | null {
  try {
    return scrubTelemetryValue(event, options);
  } catch (error) {
    options.onFallback?.(error instanceof Error ? error.message : "unknown");
  }
  try {
    const stripped = stripUrlBearingFields(event);
    return scrubTelemetryValue(stripped, options);
  } catch {
    return null;
  }
}

function stripUrlBearingFields<T extends object>(event: T): T {
  const copy: Record<string, unknown> = {
    ...(event as Record<string, unknown>),
  };
  for (const field of URL_BEARING_FIELDS) delete copy[field];
  for (const [key, child] of Object.entries(copy)) {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      const inner: Record<string, unknown> = {
        ...(child as Record<string, unknown>),
      };
      for (const field of URL_BEARING_FIELDS) delete inner[field];
      copy[key] = inner;
    }
  }
  return copy as T;
}
