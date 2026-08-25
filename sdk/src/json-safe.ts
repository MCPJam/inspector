/**
 * JSON-safe payloads for persisted reports.
 *
 * Conformance checks attach the raw thrown value as `error.details` so
 * operators can see WHY a check failed. Those reports get persisted, and the
 * persistence layer (Convex) rejects class instances outright: a live run
 * against an OAuth-protected server put an `MCPAuthError` instance into
 * `details.errorDetails`, the report write failed with "is not a supported
 * Convex type", and the executor then replaced the FINISHED report with a
 * `could-not-run` skip. Sanitize at the producer: every value entering a
 * report must already be plain JSON data — no class instances, no
 * `undefined`, no functions.
 */

const MAX_DEPTH = 8;

/**
 * Deeply convert an arbitrary value into plain JSON-safe data.
 *
 * - Primitives pass through (`NaN`/`Infinity` and bigints become strings).
 * - `undefined`, functions and symbols are dropped from objects and become
 *   `null` inside arrays, matching `JSON.stringify` semantics.
 * - Errors become plain objects carrying `name`, `message`, `code`,
 *   `statusCode` and `cause` when present, plus their own enumerable
 *   properties. Stacks are deliberately omitted.
 * - Any other class instance is flattened to its own enumerable properties.
 * - Dates and URLs become strings; Maps and Sets become arrays.
 * - Cycles are replaced with `"[circular]"` and depth is capped so a
 *   pathological payload cannot blow up the report.
 */
export function deepJsonSafe(value: unknown): unknown {
  return jsonSafeValue(value, 0, new WeakSet());
}

function jsonSafeValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (value === null) {
    return null;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    default:
      break;
  }

  const obj = value as object;
  if (seen.has(obj)) {
    return "[circular]";
  }
  if (depth >= MAX_DEPTH) {
    return "[max-depth]";
  }
  if (obj instanceof Date) {
    return obj.toISOString();
  }
  if (obj instanceof URL) {
    return obj.toString();
  }

  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map(
        (entry) => jsonSafeValue(entry, depth + 1, seen) ?? null,
      );
    }
    if (obj instanceof Map) {
      return [...obj.entries()].map(([key, entry]) => [
        jsonSafeValue(key, depth + 1, seen) ?? null,
        jsonSafeValue(entry, depth + 1, seen) ?? null,
      ]);
    }
    if (obj instanceof Set) {
      return [...obj].map(
        (entry) => jsonSafeValue(entry, depth + 1, seen) ?? null,
      );
    }

    const out: Record<string, unknown> = {};
    if (obj instanceof Error) {
      out.name = obj.name;
      out.message = obj.message;
      const coded = obj as Error & {
        code?: unknown;
        statusCode?: unknown;
        cause?: unknown;
      };
      if (coded.code !== undefined) {
        out.code = jsonSafeValue(coded.code, depth + 1, seen);
      }
      if (coded.statusCode !== undefined) {
        out.statusCode = jsonSafeValue(coded.statusCode, depth + 1, seen);
      }
      if (coded.cause !== undefined) {
        out.cause = jsonSafeValue(coded.cause, depth + 1, seen);
      }
    }
    for (const [key, entry] of Object.entries(obj)) {
      const safe = jsonSafeValue(entry, depth + 1, seen);
      if (safe !== undefined) {
        out[key] = safe;
      }
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}
