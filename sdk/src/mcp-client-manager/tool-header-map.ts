/**
 * Per-tool `Mcp-Param-*` header discovery cache for the 2026-07-28
 * stateless preview. See SEP-2243 ("Header conveyance for sensitive
 * params") for the wire spec, and `peppy-popping-flask.md` PR2 for plan
 * context.
 *
 * Tools annotate sensitive parameters with `x-mcp-header: <Name>` on the
 * input-schema property. Clients that observe such an annotation MUST
 * lift the value out of the JSON-RPC body and into a per-request
 * `Mcp-Param-<Name>` HTTP header. The mapping is derived from the
 * server's `tools/list` response, so this cache is just a memoized form
 * of "which params on which tool need header lifting."
 *
 * **Invalidation:**
 *   - `close()` on the owning client (`clear()` here)
 *   - TTL expiry per SEP-2549 (`isFresh()` returns false → caller
 *     re-fetches via `listTools` before the next `callTool`)
 *   - Missing / zero / negative `ttlMs` → treat as immediately stale
 *     (`isFresh()` returns false unconditionally)
 *   - Failed `tools/list` during lazy refresh → fail the call, NEVER
 *     serve a stale entry for a tool that may require headers
 *
 * **Scope:** one cache instance per concrete preview client, bound to
 * the resolved auth context (bearer token / refresh provider). Sharing
 * across servers, users, access tokens, or auth providers would violate
 * `cacheScope` semantics — a tool advertised as `cacheScope: "public"`
 * still gets a private cache here because mixing across auth contexts
 * could leak Mcp-Param-* header values across users.
 */

import { PaginatedToolHeaderDiscoveryUnsupported } from "./managed-mcp-client.js";

const X_MCP_HEADER_KEY = "x-mcp-header";

/**
 * Header name → RFC 7230 token regex.
 *
 * SEP-2243 forbids:
 *   - empty string
 *   - non-ASCII characters
 *   - characters outside the HTTP token grammar (RFC 7230 §3.2.6)
 *   - collisions across params on the same tool
 *
 * We validate at parse time and exclude offending tools (with a warning)
 * rather than dropping just the offending param — letting the call
 * proceed without a header the server requires is the worst failure
 * mode here.
 */
const HEADER_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export interface ToolHeaderMapEntry {
  /** Map of input-schema property name → HTTP header name (un-prefixed). */
  paramToHeader: Map<string, string>;
}

export interface ParsedTool {
  name: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
  };
  /** Optional SEP-2549 cache hint at the tool level. */
  cacheScope?: unknown;
}

export interface ParseToolsResult {
  entries: Map<string, ToolHeaderMapEntry>;
  warnings: string[];
}

/**
 * Build a header map from a `tools/list` page. Tools with invalid
 * annotations are excluded from the map (and the caller should ALSO
 * exclude them from any advertised tool list — never let the model pick
 * a tool whose Mcp-Param-* requirements we can't satisfy). Reasons land
 * in `warnings` for the RPC logger.
 */
export function parseToolsForHeaderMap(
  tools: ParsedTool[],
): ParseToolsResult {
  const entries = new Map<string, ToolHeaderMapEntry>();
  const warnings: string[] = [];

  for (const tool of tools) {
    const props = tool.inputSchema?.properties;
    if (!props || typeof props !== "object") {
      entries.set(tool.name, { paramToHeader: new Map() });
      continue;
    }
    const paramToHeader = new Map<string, string>();
    const seenHeaderNames = new Set<string>();
    let invalid = false;

    for (const [paramName, schema] of Object.entries(props)) {
      if (!schema || typeof schema !== "object") continue;
      const annotation = (schema as Record<string, unknown>)[X_MCP_HEADER_KEY];
      if (annotation === undefined) continue;

      if (typeof annotation !== "string") {
        warnings.push(
          `tool "${tool.name}" param "${paramName}": x-mcp-header must be a string; got ${typeof annotation}. Tool excluded.`,
        );
        invalid = true;
        break;
      }
      const headerName = annotation;
      if (headerName === "") {
        warnings.push(
          `tool "${tool.name}" param "${paramName}": x-mcp-header must not be empty. Tool excluded.`,
        );
        invalid = true;
        break;
      }
      if (!HEADER_TOKEN_RE.test(headerName)) {
        warnings.push(
          `tool "${tool.name}" param "${paramName}": x-mcp-header "${headerName}" contains characters outside the RFC 7230 token grammar (non-ASCII, whitespace, or separator). Tool excluded.`,
        );
        invalid = true;
        break;
      }
      const lower = headerName.toLowerCase();
      if (seenHeaderNames.has(lower)) {
        warnings.push(
          `tool "${tool.name}": x-mcp-header "${headerName}" is not unique within the tool (HTTP header names are case-insensitive). Tool excluded.`,
        );
        invalid = true;
        break;
      }
      seenHeaderNames.add(lower);

      // SEP-2243: `x-mcp-header` is only valid on primitive parameter
      // types (`string`, `number`, `boolean`). Spec text: "Clients
      // MUST reject tool definitions where any x-mcp-header value
      // violates these constraints. Rejection means the client MUST
      // exclude the invalid tool from the result of tools/list."
      //
      // When the schema explicitly declares a non-primitive type
      // (`object` / `array` / `null`), exclude the entire tool with a
      // warning. Schemas without an explicit `type` (untyped /
      // implicit-any) get the benefit of the doubt here — runtime
      // dispatch still rejects non-primitive values at the body
      // mirroring step, but failing loud at definition time is the
      // spec-mandated path for declared non-primitives.
      const schemaType = (schema as { type?: unknown }).type;
      if (
        schemaType === "object" ||
        schemaType === "array" ||
        schemaType === "null"
      ) {
        warnings.push(
          `tool "${tool.name}" param "${paramName}": x-mcp-header "${headerName}" is declared on a non-primitive schema (type: ${String(schemaType)}). SEP-2243 requires primitive types (string / number / boolean). Tool excluded.`,
        );
        invalid = true;
        break;
      }
      paramToHeader.set(paramName, headerName);
    }

    if (!invalid) {
      entries.set(tool.name, { paramToHeader });
    }
  }

  return { entries, warnings };
}

export class ToolHeaderMap {
  private entries = new Map<string, ToolHeaderMapEntry>();
  /**
   * Absolute expiry time (ms since epoch) for the current entries.
   * `undefined` = not yet populated (a fresh client). After `update()`,
   * either a positive number (ttl from the page) or `0` (stale on
   * arrival — caller refreshes on next access).
   */
  private expiresAt: number | undefined;
  private excludedTools = new Set<string>();

  /**
   * Replace the cache contents from a `tools/list` response. `ttlMs`
   * comes from the page envelope per SEP-2549. Stale-on-arrival
   * (missing / zero / negative) is allowed — `isFresh()` returns false
   * and the next access lazily refreshes.
   *
   * Also resets the excluded-tools set so a server that fixed a tool's
   * `x-mcp-header` annotation in a later refresh stops being hidden.
   * Callers `recordExcluded()` after `update()` for the new page, so the
   * exclusion set reflects the current page only.
   */
  update(
    entries: Map<string, ToolHeaderMapEntry>,
    ttlMs: number | undefined,
    now: number = Date.now(),
  ): void {
    this.entries = entries;
    this.excludedTools = new Set();
    if (typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0) {
      this.expiresAt = now + ttlMs;
    } else {
      // Stale on arrival — preserves the "no caching" path while still
      // letting tests assert the map was populated.
      this.expiresAt = 0;
    }
  }

  /**
   * Record a tool that was excluded from the map (invalid annotation,
   * pagination guard, etc.). The preview should NOT advertise these to
   * the model — exposes a separate getter so the caller can filter.
   */
  recordExcluded(toolName: string): void {
    this.excludedTools.add(toolName);
  }

  /** Set of tool names that failed annotation validation. */
  getExcludedTools(): ReadonlySet<string> {
    return this.excludedTools;
  }

  /**
   * Whether the cache is non-empty AND within its TTL. Returns false
   * for a never-populated map, a stale-on-arrival map, or an expired
   * map. Callers should call `update()` before deriving headers when
   * `isFresh()` is false.
   */
  isFresh(now: number = Date.now()): boolean {
    if (this.expiresAt === undefined) return false;
    if (this.expiresAt === 0) return false;
    return this.expiresAt > now;
  }

  /**
   * Header derivation for a single `tools/call`. Returns:
   *   - `headers`: `{ "Mcp-Param-<Name>": <encoded value>, ... }`
   *   - `bodyArguments`: the original `args` unchanged.
   *
   * The 2026-07-28 wire contract is **mirror, not lift**: the
   * annotated value is sent BOTH in `params.arguments[<name>]` (the
   * normal JSON-RPC body) AND in `Mcp-Param-<HeaderName>`. The server
   * validates that the two arrived consistently and rejects with
   * `-32001 HeaderMismatch` if they diverge.
   *
   * Earlier revisions of this preview stripped the lifted value from
   * the body; that fails against conforming servers because the
   * header validator finds the body slot missing. Mirroring is also
   * defense-in-depth: a proxy that strips the header silently doesn't
   * change runtime behavior.
   *
   * Primitives only (string / number / boolean). Objects / arrays /
   * null / undefined skip header emission — they stay in the body
   * as-is so the server-side schema validator can act on them rather
   * than us silently dropping the value.
   */
  deriveHeaders(
    toolName: string,
    args: Record<string, unknown> | undefined,
  ): {
    headers: Record<string, string>;
    bodyArguments: Record<string, unknown> | undefined;
  } {
    const entry = this.entries.get(toolName);
    if (!entry || entry.paramToHeader.size === 0 || !args) {
      return { headers: {}, bodyArguments: args };
    }

    const headers: Record<string, string> = {};
    for (const [paramName, headerName] of entry.paramToHeader) {
      if (!(paramName in args)) continue;
      const value = args[paramName];
      if (value === null || value === undefined) continue;
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        // Non-primitive: skip the header. SEP-2243 only mandates
        // header conveyance for primitives. The body still carries
        // the value; the server is responsible for deciding what to
        // do with a non-primitive annotated param.
        continue;
      }
      headers[`Mcp-Param-${headerName}`] = encodeHeaderValue(String(value));
    }
    // Mirror semantics: body is the caller's args verbatim.
    return { headers, bodyArguments: args };
  }

  clear(): void {
    this.entries.clear();
    this.excludedTools.clear();
    this.expiresAt = undefined;
  }
}

/**
 * Encode a header value per SEP-2243. Plain ASCII visible characters
 * pass through verbatim; non-ASCII / control / whitespace / leading or
 * trailing whitespace get wrapped as `=?base64?{Base64UTF8}?=`.
 *
 * The `=?base64?...?=` envelope is a deliberate subset of RFC 2047 —
 * SEP-2243 keeps the syntax token-identical so legacy parsers don't
 * choke, but mandates UTF-8 base64 specifically (RFC 2047 allows
 * Q-encoding too; SEP-2243 does not).
 */
export function encodeHeaderValue(raw: string): string {
  if (raw === "") return raw;
  // Disallow if any char is non-printable ASCII or outside ASCII; also
  // wrap when leading/trailing whitespace is present (servers may trim).
  const needsWrap =
    /[^\x20-\x7e]/.test(raw) ||
    raw[0] === " " ||
    raw[0] === "\t" ||
    raw[raw.length - 1] === " " ||
    raw[raw.length - 1] === "\t";
  if (!needsWrap) return raw;
  // Encode UTF-8 → base64. Node's Buffer is canonical here; tests run
  // under node with Buffer global available, and the preview always
  // runs in a Node-compatible runtime (the manager itself imports
  // `StdioClientTransport` which is Node-only).
  const utf8 =
    typeof Buffer !== "undefined"
      ? Buffer.from(raw, "utf-8").toString("base64")
      : btoa(unescape(encodeURIComponent(raw))); // browser fallback
  return `=?base64?${utf8}?=`;
}

/**
 * Walk a paginated `tools/list` response and reject early. The preview
 * fails loud on pagination during header discovery — building a partial
 * map would silently drop Mcp-Param-* headers for unlisted tools, and
 * the failure mode (server rejects with -32001 HeaderMismatch on a
 * tools/call) is hard to diagnose. See plan §"Cache semantics."
 */
export function assertNotPaginated(
  page: { nextCursor?: string | null | undefined } | undefined,
): void {
  if (page && page.nextCursor !== undefined && page.nextCursor !== null) {
    throw new PaginatedToolHeaderDiscoveryUnsupported();
  }
}
