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

/** Methods for which `Mcp-Name` is REQUIRED (SEP-2243 Standard Request Headers). */
const NAME_REQUIRED_METHODS = new Set([
  "tools/call",
  "resources/read",
  "prompts/get",
]);

/**
 * The `io.modelcontextprotocol/tasks` methods that MUST carry
 * `Mcp-Name: <taskId>` (SEP-2663, "Streamable HTTP: Routing Headers").
 *
 * A second required-name set rather than an addition to the one above: the
 * source field differs (`params.taskId`, not `params.name`), and the
 * requirement comes from the extension, which is versioned independently of
 * core. `transport-utils` sends these headers; this module judges them, and
 * both read the set from here so the two halves cannot drift.
 */
export const TASK_ROUTED_METHODS = new Set([
  "tasks/get",
  "tasks/update",
  "tasks/cancel",
]);

/** Whether `Mcp-Name` is required for `method`, across core and the tasks extension. */
export function isNameRequiredMethod(method: string | undefined): boolean {
  if (method === undefined) return false;
  return NAME_REQUIRED_METHODS.has(method) || TASK_ROUTED_METHODS.has(method);
}

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
  if (method !== undefined && TASK_ROUTED_METHODS.has(method)) {
    return ".params.taskId";
  }
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
            required: isNameRequiredMethod(body.method),
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
    // A sentinel that will not decode is a defect only where the spec defines
    // the sentinel: `Mcp-Name` (handled above) and `Mcp-Param-{Name}`, whose
    // invalid characters servers MUST reject. `Mcp-Session-Id`/`Last-Event-ID`
    // have no encoded form at all, and a legacy value merely RESEMBLING the
    // sentinel is just a value — claiming -32020 for either would be invented.
    const undecodable = crossCheck && family === "param" && !!decoded.decodeError;
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

// ---------------------------------------------------------------------------
// Send side: `x-mcp-header` scan + `Mcp-Param-*` construction
// ---------------------------------------------------------------------------

/**
 * The rest of this module judges headers that were already sent. What follows
 * BUILDS them, and exists here only because the upstream client does not let
 * us reuse its copy.
 *
 * `@modelcontextprotocol/client` implements this identically, but the two
 * functions (`scanXMcpHeaderDeclarations`, `buildMcpParamHeaders`) are private
 * to the bundle: they are reachable only through `Client.callTool()`, which
 * cannot carry `requestState` / `inputResponses` and so cannot be used for the
 * MRTR legs in `executeToolWithInputRequired`. Without a local copy every
 * `tools/call` MCPJam makes on a modern connection omits `Mcp-Param-*` and a
 * conforming server answers `-32020 HeaderMismatch`.
 *
 * This is a deliberate, temporary fork of upstream behavior, kept
 * line-for-line faithful so the two cannot diverge in meaning. DELETE IT and
 * import from the SDK once upstream exports the pair (or moves mirroring down
 * into the request layer alongside `Mcp-Method` / `Mcp-Name`, which is the
 * better fix and the one to propose). Any change here must be a change
 * upstream made first.
 */

/** The `inputSchema` extension property carrying a header declaration. */
const X_MCP_HEADER_KEY = "x-mcp-header";

/** Canonical send-side casing. The classifier above compares lowercased. */
const MCP_PARAM_HEADER_SEND_PREFIX = "Mcp-Param-";

/**
 * RFC 9110 §5.1 `token` syntax (`1*tchar`). Rejects empty, space, control
 * characters (including CR/LF), and the listed delimiters.
 */
const RFC9110_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * JSON Schema `type` values admitted on an `x-mcp-header` property.
 *
 * The spec text names `integer`, `string`, `boolean` and explicitly excludes
 * `number`. Upstream accepts `number` anyway because the published
 * conformance referee ships its `http-custom-headers` scenario with two
 * `type: "number"` declarations and expects them mirrored. Matching upstream
 * matters more than matching the prose: diverging here would make MCPJam and
 * the SDK disagree about which tools are valid.
 */
const PERMITTED_X_MCP_HEADER_TYPES = new Set([
  "string",
  "integer",
  "boolean",
  "number",
]);

/**
 * JSON Schema keywords whose subschemas the SEP-2243 static-reachability
 * constraint excludes from the `properties`-only chain. An `x-mcp-header`
 * found under any of these invalidates the whole tool definition.
 */
const NON_REACHABLE_SUBSCHEMA_KEYWORDS = [
  "items",
  "prefixItems",
  "contains",
  "additionalProperties",
  "unevaluatedProperties",
  "unevaluatedItems",
  "propertyNames",
  "patternProperties",
  "dependentSchemas",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "$defs",
  "definitions",
] as const;

/**
 * Subschema-carrying keywords whose value is a `name → subschema` map rather
 * than a single subschema or an array of them; the walk branches over
 * `Object.values()` for these.
 */
const OBJECT_VALUED_SUBSCHEMA_KEYWORDS = new Set<string>([
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
]);

/** One validated `x-mcp-header` declaration found on a tool's `inputSchema`. */
export type XMcpHeaderDeclaration = {
  /** Property path from the schema root, through `properties` keys only. */
  path: string[];
  /** The declared header name, in the casing the schema used. */
  headerName: string;
  /** The declared JSON Schema primitive type. */
  type: string;
};

export type XMcpHeaderScan =
  | { valid: true; declarations: XMcpHeaderDeclaration[] }
  | { valid: false; reason: string };

function pathName(path: string[]): string {
  return path.length === 0 ? "<root>" : path.join(".");
}

/**
 * Scan a tool's `inputSchema` for `x-mcp-header` declarations, validating
 * every constraint the spec places on them. Returns the collected
 * declarations (possibly empty) or the first violated constraint.
 *
 * The walk descends `properties` at any depth (the spec's "any nesting depth"
 * clause). The static-reachability MUST is enforced structurally: every
 * position the chain MUST NOT pass through is visited too, and a declaration
 * found anywhere on such a path invalidates the tool definition rather than
 * being silently ignored.
 */
export function scanXMcpHeaderDeclarations(
  inputSchema: unknown
): XMcpHeaderScan {
  const declarations: XMcpHeaderDeclaration[] = [];
  const seenLower = new Map<string, string>();

  const visit = (
    node: unknown,
    path: string[],
    reachable: boolean
  ): string | undefined => {
    if (node === null || typeof node !== "object") return undefined;
    const schema = node as Record<string, unknown>;

    if (X_MCP_HEADER_KEY in schema) {
      const at = pathName(path);
      if (!reachable || path.length === 0) {
        return `${at}: x-mcp-header is only permitted on properties statically reachable via a chain of 'properties' keys (not under items, additionalProperties, oneOf/anyOf/allOf/not, if/then/else, or $ref)`;
      }
      const raw = schema[X_MCP_HEADER_KEY];
      if (typeof raw !== "string" || raw.length === 0) {
        return `${at}: x-mcp-header MUST be a non-empty string`;
      }
      if (!RFC9110_TOKEN.test(raw)) {
        return `${at}: x-mcp-header '${raw}' is not a valid RFC 9110 token (no spaces, control characters or HTTP delimiters)`;
      }
      const type = typeof schema.type === "string" ? schema.type : undefined;
      if (type === undefined || !PERMITTED_X_MCP_HEADER_TYPES.has(type)) {
        const got = type ?? "<none>";
        return `${at}: x-mcp-header is only permitted on primitive-typed properties (string, integer, boolean); got ${got}`;
      }
      const lower = raw.toLowerCase();
      const prior = seenLower.get(lower);
      if (prior !== undefined) {
        return `x-mcp-header '${raw}' is not case-insensitively unique (also declared as '${prior}')`;
      }
      seenLower.set(lower, raw);
      declarations.push({ path, headerName: raw, type });
    }

    const properties = schema.properties;
    if (properties !== null && typeof properties === "object") {
      for (const [key, child] of Object.entries(
        properties as Record<string, unknown>
      )) {
        const fault = visit(child, [...path, key], reachable);
        if (fault !== undefined) return fault;
      }
    }

    for (const keyword of NON_REACHABLE_SUBSCHEMA_KEYWORDS) {
      const sub = schema[keyword];
      if (sub === undefined) continue;
      const isNamedMap =
        sub !== null &&
        typeof sub === "object" &&
        OBJECT_VALUED_SUBSCHEMA_KEYWORDS.has(keyword);
      const branches = Array.isArray(sub)
        ? sub
        : isNamedMap
          ? Object.values(sub as Record<string, unknown>)
          : [sub];
      for (const branch of branches) {
        const fault = visit(branch, [...path, `<${keyword}>`], false);
        if (fault !== undefined) return fault;
      }
    }

    return undefined;
  };

  const fault = visit(inputSchema, [], true);
  return fault === undefined
    ? { valid: true, declarations }
    : { valid: false, reason: fault };
}

function utf8ToBase64(value: string): string {
  const scope = globalThis as {
    btoa?: (data: string) => string;
    Buffer?: {
      from: (
        data: string,
        enc: string
      ) => { toString: (enc: string) => string };
    };
  };
  const bytes = new TextEncoder().encode(value);
  if (typeof scope.btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCodePoint(byte);
    return scope.btoa(binary);
  }
  if (scope.Buffer) {
    return scope.Buffer.from(value, "utf8").toString("base64");
  }
  throw new Error("no base64 encoder available");
}

/**
 * `true` when `value` cannot ride as a plain ASCII HTTP field value per
 * RFC 9110 §5.5: it holds a byte outside `0x20–0x7E` / `0x09`, it has leading
 * or trailing whitespace (which field parsing strips), or it already looks
 * like the sentinel (the spec's "to avoid ambiguity" rule).
 */
function needsBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (
    value.startsWith(MCP_HEADER_SENTINEL_PREFIX) &&
    value.endsWith(MCP_HEADER_SENTINEL_SUFFIX)
  ) {
    return true;
  }
  if (value !== value.trim()) return true;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.codePointAt(i)!;
    if (code === 9 || (code >= 32 && code <= 126)) continue;
    return true;
  }
  return false;
}

/**
 * Encode a string as an HTTP field value: a safe plain-ASCII value passes
 * through unchanged, anything else is wrapped as `=?base64?{utf8-b64}?=`.
 * The exact inverse of {@link decodeMcpHeaderValue}.
 */
export function encodeMcpHeaderValue(value: string): string {
  if (!needsBase64(value)) return value;
  const payload = utf8ToBase64(value);
  return `${MCP_HEADER_SENTINEL_PREFIX}${payload}${MCP_HEADER_SENTINEL_SUFFIX}`;
}

/**
 * Convert a primitive argument to its wire string per the spec's conversion
 * rules: strings pass through, integers and numbers become decimal, booleans
 * become lowercase `true` / `false`. Non-finite numbers and integers outside
 * the safe range are refused — the caller reads `undefined` as "emit no
 * header", which is better than emitting a malformed one.
 */
function primitiveToHeaderString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return undefined;
    }
    return String(value);
  }
  return undefined;
}

function valueAtPath(root: unknown, path: string[]): unknown {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * Build the `Mcp-Param-{Name}` headers for one `tools/call` from a scan of the
 * tool's `inputSchema` and the call's `arguments`.
 *
 * A declaration whose value is absent or `null` in `arguments` is omitted (the
 * spec's "client MUST omit the header" rows), as is one whose value is not a
 * primitive of the declared kind — the server cross-checks header against
 * body, so a header it cannot match is worse than no header.
 */
export function buildMcpParamHeaders(
  declarations: readonly XMcpHeaderDeclaration[],
  args: unknown
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of declarations) {
    const raw = valueAtPath(args, decl.path);
    if (raw === undefined || raw === null) continue;
    const stringValue = primitiveToHeaderString(raw);
    if (stringValue === undefined) continue;
    out[`${MCP_PARAM_HEADER_SEND_PREFIX}${decl.headerName}`] =
      encodeMcpHeaderValue(stringValue);
  }
  return out;
}
