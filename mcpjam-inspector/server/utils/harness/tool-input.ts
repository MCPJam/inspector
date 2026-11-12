/** Claude Code and the ACP adapter serialize tool-call arguments as a JSON
 *  STRING (e.g. `'{"city":"NYC"}'`), but MCPJam's UI chunks, the onToolCall
 *  callback, eval arg-matching, MCP App widget capture and call attribution all
 *  expect the structured object. Parse a string input back to its object/array;
 *  fall back to the raw value when it isn't JSON or doesn't decode to a
 *  structure (don't coerce a bare string/number/bool, and pass
 *  already-structured inputs through). */
export function coerceToolInput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? parsed : raw;
  } catch {
    return raw;
  }
}
