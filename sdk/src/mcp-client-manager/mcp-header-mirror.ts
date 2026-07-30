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

/** Report/display order: the cross-checked headers, then params, then legacy state. */
const FAMILY_ORDER: McpHeaderFamily[] = [
  "protocol-version",
  "method",
  "name",
  "param",
  "session",
  "resumption",
];

/** The families carrying a REQUIRED modern cross-check (SEP-2243 standard headers). */
const CROSS_CHECKED_FAMILIES = new Set<McpHeaderFamily>([
  "protocol-version",
  "method",
  "name",
]);

/**
 * The outcome of the header/body cross-check for one header.
 *
 * `unchecked` is the honest answer for anything outside the modern standard
 * three: a legacy request mirrors nothing, and `Mcp-Param-*` values are not
 * captured, so no verdict can be claimed for them.
 */
export type McpHeaderStatus =
  | "match"
  | "mismatch"
  | "missing"
  | "not-required"
  | "undecodable"
  | "unchecked";

export type McpHeaderAssessment = {
  /** Wire casing when the header was sent; canonical lowercase when it wasn't. */
  name: string;
  family: McpHeaderFamily;
  status: McpHeaderStatus;
  /** The value as it appeared on the wire. Absent when the header was not sent. */
  raw?: string;
  /** Set only when `raw` carried a sentinel that decoded — never on `undecodable`. */
  decoded?: string;
  /** The body field this header mirrors, when a cross-check ran. */
  bodyField?: string;
  /** The body's value, on `mismatch` / `missing`. */
  bodyValue?: string;
};

/** Which body field a given method's `Mcp-Name` is mirrored FROM. */
function nameSourceField(method: string | undefined): string {
  return method === "resources/read" ? ".params.uri" : ".params.name";
}

/**
 * Per-header verdicts for the mirrored `Mcp-*` headers — the display form of
 * the same validation `findMcpHeaderIssues` reports as a defect list.
 *
 * A verdict list rather than a defect list is what a debugger needs: a header
 * shown without the body value it is supposed to equal cannot be judged, and an
 * ABSENT header is ambiguous until it says whether the spec required it here
 * (`Mcp-Name` is required only for `tools/call`, `resources/read`,
 * `prompts/get`). Both cases therefore get an explicit row.
 *
 * Era-gated exactly like `findMcpHeaderIssues`: before `2026-07-28` nothing is
 * mirrored, so every present header comes back `unchecked` rather than judged
 * against rules its version never had.
 */
export function evaluateMcpHeaders(
  headers: Record<string, string>,
  body: MirroredBodyValues | undefined
): McpHeaderAssessment[] {
  const lookup = new Map<string, { name: string; value: string }>();
  for (const [name, value] of Object.entries(headers)) {
    lookup.set(name.toLowerCase(), { name, value });
  }

  const version = lookup.get("mcp-protocol-version")?.value ?? body?.protocolVersion;
  const isModern =
    !!version && isKnownProtocolVersion(version) && isStatelessProtocolVersion(version);
  const crossCheck = isModern && !!body;

  const out: McpHeaderAssessment[] = [];
  const claimed = new Set<string>();

  const standard: Array<{
    header: string;
    family: McpHeaderFamily;
    bodyValue: string | undefined;
    bodyField: string;
    required: boolean;
  }> =
    crossCheck && body
      ? [
          {
            header: "mcp-protocol-version",
            family: "protocol-version",
            bodyValue: body.protocolVersion,
            bodyField: "._meta protocolVersion",
            required: true,
          },
          {
            header: "mcp-method",
            family: "method",
            bodyValue: body.method,
            bodyField: ".method",
            required: true,
          },
          {
            header: "mcp-name",
            family: "name",
            bodyValue: body.name,
            bodyField: nameSourceField(body.method),
            required:
              body.method !== undefined && NAME_REQUIRED_METHODS.has(body.method),
          },
        ]
      : [];

  for (const spec of standard) {
    claimed.add(spec.header);
    const found = lookup.get(spec.header);

    if (!found) {
      if (spec.required && spec.bodyValue !== undefined) {
        out.push({
          name: spec.header,
          family: spec.family,
          status: "missing",
          bodyValue: spec.bodyValue,
          bodyField: spec.bodyField,
        });
      } else if (!spec.required && body?.method !== undefined) {
        // Absent AND not required. Said out loud, because a blank row reads
        // identically to the `missing` case above.
        out.push({ name: spec.header, family: spec.family, status: "not-required" });
      }
      continue;
    }

    const decoded = decodeMcpHeaderValue(found.value);
    const base = {
      name: found.name,
      family: spec.family,
      raw: found.value,
      decoded: decoded.encoded && !decoded.decodeError ? decoded.value : undefined,
    };

    if (decoded.decodeError) {
      out.push({ ...base, status: "undecodable" });
    } else if (spec.bodyValue === undefined) {
      out.push({ ...base, status: "unchecked" });
    } else if (decoded.value === spec.bodyValue) {
      out.push({ ...base, status: "match", bodyField: spec.bodyField });
    } else {
      out.push({
        ...base,
        status: "mismatch",
        bodyValue: spec.bodyValue,
        bodyField: spec.bodyField,
      });
    }
  }

  for (const [lower, found] of lookup) {
    if (claimed.has(lower)) continue;
    const family = classifyMcpHeader(found.name);
    if (!family) continue;
    const decoded = decodeMcpHeaderValue(found.value);
    // A sentinel that will not decode is only a defect where the spec defines
    // the sentinel at all — a legacy value that merely resembles it is not.
    const undecodable = crossCheck && !!decoded.decodeError;
    out.push({
      name: found.name,
      family,
      raw: found.value,
      decoded: decoded.encoded && !decoded.decodeError ? decoded.value : undefined,
      status: undecodable ? "undecodable" : "unchecked",
    });
  }

  return out.sort(
    (a, b) =>
      FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) ||
      a.name.localeCompare(b.name)
  );
}

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
  const issues: McpHeaderIssue[] = [];
  for (const row of evaluateMcpHeaders(headers, body)) {
    // Only the standard three carry a required cross-check; a `Mcp-Param-*`
    // verdict would need the tool's `inputSchema` annotations to be sound.
    if (!CROSS_CHECKED_FAMILIES.has(row.family)) continue;
    switch (row.status) {
      case "mismatch":
        issues.push({
          kind: "mismatch",
          header: row.name,
          headerValue: row.decoded ?? row.raw ?? "",
          bodyValue: row.bodyValue ?? "",
        });
        break;
      case "missing":
        issues.push({
          kind: "missing",
          header: row.name,
          bodyValue: row.bodyValue ?? "",
        });
        break;
      case "undecodable":
        issues.push({
          kind: "undecodable",
          header: row.name,
          headerValue: row.raw ?? "",
        });
        break;
      default:
        break;
    }
  }
  return issues;
}
