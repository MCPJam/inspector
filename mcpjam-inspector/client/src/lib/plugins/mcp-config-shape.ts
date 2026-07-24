/**
 * MCP configuration shape detection — the three compatible source shapes.
 *
 * MCPJam ingests MCP server configuration in three interchangeable shapes
 * (locked architecture decision 7 of
 * docs/plans/openai-plugin-import-cross-repo.md):
 *
 *   1. a direct server map            `{ "svr": { command } }`
 *   2. an `mcp_servers` wrapper        `{ "mcp_servers": { "svr": { command } } }`
 *      (current OpenAI plugin docs)
 *   3. an `mcpServers` wrapper         `{ "mcpServers": { "svr": { command } } }`
 *      (existing MCPJam / Claude-style configs)
 *
 * The SDK's `@mcpjam/sdk/plugin-bundle` parser owns this same wrapper contract
 * for the plugin-bundle path (`normalizePluginMcpConfig`), but that normalizer
 * is (a) not part of the SDK's exported public surface and (b) deliberately
 * VALUE-STRIPPING — it stores requirement NAMES only, never resolved
 * command/env/header VALUES, because a plugin bundle must not persist secrets.
 * The JSON-import surface here is value-PRESERVING: a user pasting their own
 * `mcpServers` config expects a working server with its real command/env/url,
 * so it cannot consume the value-stripping normalizer verbatim. This module
 * therefore shares the wrapper/transport CONTRACT with the SDK while keeping
 * the value-preserving mapping local. Keep the two in sync: the accepted
 * shapes and the duplicate-wrapper / bare-server rejections mirror the SDK's
 * `normalizePluginMcpConfig` exactly.
 */

export type McpConfigWrapper = "mcp_servers" | "mcpServers" | "direct";

export type UnwrapMcpServerMapResult =
  | { ok: true; wrapper: McpConfigWrapper; servers: Record<string, unknown> }
  | { ok: false; reason: UnwrapFailureReason };

/**
 * Why a config could not be resolved to a server map. Callers map these to
 * their own (legacy-compatible) user-facing messages.
 */
export type UnwrapFailureReason =
  /** Top-level value was not a JSON object (array/null/scalar). */
  | "not-object"
  /** Declared both `mcp_servers` and `mcpServers` — ambiguous. */
  | "both-wrappers"
  /** A wrapper key was present but its value was not an object. */
  | "wrapper-not-object"
  /** No wrapper key and the object does not look like a direct server map. */
  | "no-server-map";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * A value "looks like" a server entry when it is an object carrying at least
 * one recognized transport signal (`command`, `url`, or an explicit
 * `type`/`transport`). Used only to decide whether a wrapper-less object is a
 * direct server MAP: requiring a strong per-entry signal keeps arbitrary JSON
 * (e.g. `{ "servers": {} }`) from being silently misread as a server map,
 * preserving the legacy "missing mcpServers" error for such input.
 */
function looksLikeServerEntry(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.command === "string" ||
    typeof value.url === "string" ||
    value.type !== undefined ||
    value.transport !== undefined
  );
}

/**
 * Detect whether a wrapper-less object is a direct server map: every value
 * must be an object and at least one must look like a server entry.
 */
function looksLikeServerMap(record: Record<string, unknown>): boolean {
  const values = Object.values(record);
  if (values.length === 0) return false;
  if (!values.every(isPlainObject)) return false;
  return values.some(looksLikeServerEntry);
}

/**
 * Resolve any of the three accepted MCP config shapes to a `{ name: config }`
 * server map WITHOUT stripping values. Mirrors the SDK's wrapper contract:
 * both wrappers present is rejected as ambiguous; a bare single-server object
 * is not a server map.
 */
export function unwrapMcpServerMap(config: unknown): UnwrapMcpServerMapResult {
  if (!isPlainObject(config)) {
    return { ok: false, reason: "not-object" };
  }

  const hasSnake = Object.prototype.hasOwnProperty.call(config, "mcp_servers");
  const hasCamel = Object.prototype.hasOwnProperty.call(config, "mcpServers");

  if (hasSnake && hasCamel) {
    return { ok: false, reason: "both-wrappers" };
  }

  if (hasCamel) {
    const servers = config.mcpServers;
    if (!isPlainObject(servers)) {
      return { ok: false, reason: "wrapper-not-object" };
    }
    return { ok: true, wrapper: "mcpServers", servers };
  }

  if (hasSnake) {
    const servers = config.mcp_servers;
    if (!isPlainObject(servers)) {
      return { ok: false, reason: "wrapper-not-object" };
    }
    return { ok: true, wrapper: "mcp_servers", servers };
  }

  // No wrapper key: accept a direct server map only when the object plausibly
  // IS one. A bare single server config (top-level string `command`/`url`) is
  // not a map — this matches the SDK, which rejects that shape.
  if (typeof config.command === "string" || typeof config.url === "string") {
    return { ok: false, reason: "no-server-map" };
  }
  if (looksLikeServerMap(config)) {
    return { ok: true, wrapper: "direct", servers: config };
  }
  return { ok: false, reason: "no-server-map" };
}
