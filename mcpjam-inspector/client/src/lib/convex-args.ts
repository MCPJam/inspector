/**
 * Recursively drop object keys that Convex reserves in function arguments —
 * any field name starting with "$" or "_". MCP tool definitions routinely carry
 * such keys (JSON Schema's `$schema`/`$ref`/`$defs`/`$id`, MCP's `_meta`), and
 * the Convex client throws `Field name $… is reserved` when serializing args
 * that contain them. Use this to sanitize a tool/snapshot payload before passing
 * it to a Convex query. Arrays and nested objects are walked; primitives pass
 * through unchanged. Returns a new value — the input is not mutated.
 */
export function stripConvexReservedKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripConvexReservedKeys(entry)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith("$") || key.startsWith("_")) continue;
      out[key] = stripConvexReservedKeys(val);
    }
    return out as T;
  }
  return value;
}
