import { protocolEra } from "@mcpjam/sdk";

/** Results that carry `ttlMs` and `cacheScope` on 2026-07-28. */
const CACHEABLE_METHODS = new Set([
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "server/discover",
]);

/**
 * Whether a request was sent in a 2026-07-28-era revision: its `_meta`
 * envelope names it, or else the version `initialize` asked for.
 */
export function isModernRequest(
  params: unknown,
  initializeVersion: string | undefined,
): boolean {
  const meta = (params as { _meta?: Record<string, unknown> } | undefined)
    ?._meta;
  const version = meta?.["io.modelcontextprotocol/protocolVersion"];
  return (
    protocolEra(typeof version === "string" ? version : initializeVersion) ===
    "modern"
  );
}

/**
 * A 2026-07-28 client requires `resultType` on every result and the cache
 * fields on cacheable ones; Claude Code rejects a list without them, retries,
 * and runs the turn without the server's tools. The upstream sends them, but
 * MCPJam's client drops `resultType` when it decodes a result, so the bridge
 * puts them back the way the official server SDK's encoder fills them.
 */
export function encodeModernResult(method: string, result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const fields = result as Record<string, unknown>;
  const stamped =
    fields.resultType === undefined
      ? { ...fields, resultType: "complete" }
      : fields;
  if (stamped.resultType !== "complete" || !CACHEABLE_METHODS.has(method)) {
    return stamped;
  }
  const { ttlMs, cacheScope } = stamped;
  return {
    ...stamped,
    ttlMs:
      typeof ttlMs === "number" && Number.isInteger(ttlMs) && ttlMs >= 0
        ? ttlMs
        : 0,
    cacheScope:
      cacheScope === "public" || cacheScope === "private"
        ? cacheScope
        : "private",
  };
}
