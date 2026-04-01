const RESERVED_CONVEX_KEY_PREFIX = "$";
const ESCAPED_CONVEX_KEY_PREFIX = "__convexReserved__";

function sanitizeObjectKey(key: string): string {
  if (!key.startsWith(RESERVED_CONVEX_KEY_PREFIX)) {
    return key;
  }
  return `${ESCAPED_CONVEX_KEY_PREFIX}${key.slice(1)}`;
}

function desanitizeObjectKey(key: string): string {
  if (!key.startsWith(ESCAPED_CONVEX_KEY_PREFIX)) {
    return key;
  }
  return `${RESERVED_CONVEX_KEY_PREFIX}${key.slice(ESCAPED_CONVEX_KEY_PREFIX.length)}`;
}

export function sanitizeForConvexTransport<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForConvexTransport(item)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[sanitizeObjectKey(key)] = sanitizeForConvexTransport(entry);
  }
  return out as T;
}

/** Reverses keys escaped by {@link sanitizeForConvexTransport} (`__convexReserved__x` → `$x`). */
export function desanitizeFromConvexTransport<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => desanitizeFromConvexTransport(item)) as T;
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[desanitizeObjectKey(key)] = desanitizeFromConvexTransport(entry);
  }
  return out as T;
}
