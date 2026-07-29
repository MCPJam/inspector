/**
 * The Streamable HTTP "request metadata" headers — the body fields the
 * transport mirrors into HTTP so intermediaries can route without parsing the
 * body (SEP-2243, integrated into `2026-07-28`).
 *
 * Pure data + pure functions, no transport and no Node built-ins, so this
 * module is safe to re-export from the browser entry: the Tracing panel does
 * the same decode/cross-check a server does, on headers captured on the wire.
 *
 * Scope note: `MCP-Protocol-Version` exists from `2025-06-18` onward and the
 * session/resumption headers exist ONLY in `2025-03-26`..`2025-11-25`. This
 * module therefore classifies every era's headers, and gates only the
 * *modern-only* assertions (required `Mcp-Method`/`Mcp-Name`, header/body
 * agreement) on a modern protocol version.
 */

import { isKnownProtocolVersion, isStatelessProtocolVersion } from "./mcp-protocol-version.js";

/** Sentinel wrapper for header values that cannot ride as plain ASCII. */
export const MCP_HEADER_SENTINEL_PREFIX = "=?base64?";
export const MCP_HEADER_SENTINEL_SUFFIX = "?=";

/** Prefix for the per-argument mirrored headers driven by `x-mcp-header`. */
export const MCP_PARAM_HEADER_PREFIX = "mcp-param-";

/**
 * Which mirrored family a header belongs to, or `undefined` for an ordinary
 * header (`content-type`, `authorization`, …).
 */
export type McpHeaderFamily =
  | "protocol-version"
  | "method"
  | "name"
  | "param"
  | "session"
  | "resumption";

/**
 * Classifies a header name. RFC 9110 field names are case-insensitive and the
 * spec requires case-insensitive comparison, so callers may pass any casing —
 * note the spec text itself writes `Mcp-Session-Id` in `2025-06-18` and
 * `MCP-Session-Id` in `2025-11-25`.
 */
export function classifyMcpHeader(name: string): McpHeaderFamily | undefined {
  const lower = name.toLowerCase();
  if (lower === "mcp-protocol-version") return "protocol-version";
  if (lower === "mcp-method") return "method";
  if (lower === "mcp-name") return "name";
  if (lower === "mcp-session-id") return "session";
  if (lower === "last-event-id") return "resumption";
  if (lower.startsWith(MCP_PARAM_HEADER_PREFIX)) return "param";
  return undefined;
}

function base64ToUtf8(encoded: string): string {
  const scope = globalThis as {
    atob?: (data: string) => string;
    Buffer?: { from: (data: string, enc: string) => { toString: (enc: string) => string } };
  };
  if (typeof scope.atob === "function") {
    const binary = scope.atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (scope.Buffer) {
    return scope.Buffer.from(encoded, "base64").toString("utf8");
  }
  throw new Error("no base64 decoder available");
}

export type DecodedMcpHeaderValue = {
  /** The value exactly as it appeared on the wire. */
  raw: string;
  /** True when `raw` carried the `=?base64?…?=` sentinel. */
  encoded: boolean;
  /** The comparison value: decoded when encoded, otherwise `raw`. */
  value: string;
  /** Set when the sentinel was present but the payload would not decode. */
  decodeError?: string;
};

/**
 * Decodes the sentinel form. Applies to `Mcp-Name` as well as
 * `Mcp-Param-{Name}` — a non-ASCII tool name is carried encoded, so a UI that
 * decodes params but not names shows a conforming request as gibberish.
 *
 * The markers are case-sensitive and MUST appear exactly as lowercase, so a
 * value that merely resembles them is left alone.
 */
export function decodeMcpHeaderValue(raw: string): DecodedMcpHeaderValue {
  if (
    !raw.startsWith(MCP_HEADER_SENTINEL_PREFIX) ||
    !raw.endsWith(MCP_HEADER_SENTINEL_SUFFIX) ||
    raw.length < MCP_HEADER_SENTINEL_PREFIX.length + MCP_HEADER_SENTINEL_SUFFIX.length
  ) {
    return { raw, encoded: false, value: raw };
  }
  const payload = raw.slice(
    MCP_HEADER_SENTINEL_PREFIX.length,
    raw.length - MCP_HEADER_SENTINEL_SUFFIX.length
  );
  try {
    return { raw, encoded: true, value: base64ToUtf8(payload) };
  } catch (error) {
    return {
      raw,
      encoded: true,
      value: raw,
      decodeError: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The values the request BODY carries for the mirrored headers. Captured at
 * request time so the cross-check can run later without ever storing the body.
 */
export type MirroredBodyValues = {
  /** JSON-RPC `method`. */
  method?: string;
  /** `params.name`, or `params.uri` for `resources/read`. */
  name?: string;
  /** `_meta["io.modelcontextprotocol/protocolVersion"]`. */
  protocolVersion?: string;
};

/** Methods for which `Mcp-Name` is REQUIRED. */
const NAME_REQUIRED_METHODS = new Set([
  "tools/call",
  "resources/read",
  "prompts/get",
]);

export type McpHeaderIssue =
  | { kind: "mismatch"; header: string; headerValue: string; bodyValue: string }
  | { kind: "missing"; header: string; bodyValue: string }
  | { kind: "undecodable"; header: string; headerValue: string };

/**
 * Runs the server-side validation a `-32020 HeaderMismatch` reports, locally,
 * against the captured headers. Covers all three failure conditions the spec
 * lists: a required standard header missing, a value disagreeing with the
 * body, and a value that will not decode.
 *
 * Returns an empty list for any non-modern request: `Mcp-Method`/`Mcp-Name`
 * are not required before `2026-07-28`, so asserting them on a `2025-11-25`
 * connection would invent failures.
 */
export function findMcpHeaderIssues(
  headers: Record<string, string>,
  body: MirroredBodyValues | undefined
): McpHeaderIssue[] {
  const lookup = new Map<string, { name: string; value: string }>();
  for (const [name, value] of Object.entries(headers)) {
    lookup.set(name.toLowerCase(), { name, value });
  }

  const versionHeader = lookup.get("mcp-protocol-version")?.value;
  const version = versionHeader ?? body?.protocolVersion;
  const isModern =
    !!version && isKnownProtocolVersion(version) && isStatelessProtocolVersion(version);
  if (!isModern || !body) return [];

  const issues: McpHeaderIssue[] = [];

  const check = (
    headerName: string,
    bodyValue: string | undefined,
    required: boolean
  ) => {
    const found = lookup.get(headerName);
    if (bodyValue === undefined) return;
    if (!found) {
      if (required) {
        issues.push({ kind: "missing", header: headerName, bodyValue });
      }
      return;
    }
    const decoded = decodeMcpHeaderValue(found.value);
    if (decoded.decodeError) {
      issues.push({
        kind: "undecodable",
        header: found.name,
        headerValue: found.value,
      });
      return;
    }
    if (decoded.value !== bodyValue) {
      issues.push({
        kind: "mismatch",
        header: found.name,
        headerValue: decoded.value,
        bodyValue,
      });
    }
  };

  check("mcp-protocol-version", body.protocolVersion, true);
  check("mcp-method", body.method, true);
  check(
    "mcp-name",
    body.name,
    body.method !== undefined && NAME_REQUIRED_METHODS.has(body.method)
  );

  return issues;
}
