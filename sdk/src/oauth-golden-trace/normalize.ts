/**
 * HP-44 — normalization + redaction for golden traces.
 *
 * Two jobs, both done at CAPTURE time so that what lands on disk is already
 * safe and already diffable:
 *
 *  1. REDACT. Tokens, codes, verifiers and secrets never reach the artifact.
 *     This reuses `redactSensitiveValue` from `../redaction.js` — the deep
 *     authorization-key redactor the rest of the SDK already trusts — rather
 *     than growing a second, subtly different policy. `assertTraceIsRedacted`
 *     then re-checks the result, so a redaction bug fails a test instead of
 *     silently committing a live credential.
 *
 *  2. PLACEHOLD VOLATILITY. A `state`, a `nonce`, a PKCE challenge, a session
 *     id, an ephemeral port and a timestamp all differ between two runs of the
 *     SAME client. Left raw they would drown every real finding in noise; the
 *     diff would be useless and nobody would run it.
 *
 * The discipline that keeps step 2 from destroying evidence: where the SHAPE of
 * a volatile value is itself a finding, the shape is preserved in the
 * placeholder. `{code_challenge:len=43,charset=base64url}` still proves S256 of
 * a 32-byte verifier; a bare `{code_challenge}` would not. Ports get the same
 * treatment one level up — placeheld in the wire, retained in
 * `observations.dcrIdentity.observedLoopbackPorts`.
 *
 * What is deliberately NOT normalized:
 *   - `user-agent`, unless `normalizeVersions` is set. It is one of the fields
 *     the harness exists to capture, and a version bump IS drift worth flagging
 *     (HP-38), not noise worth hiding.
 *   - a `client_id` that parses as an http(s) URL. Under CIMD the client_id IS
 *     the identity document URL; placeholding it would erase the finding.
 *   - `expires_in`, `scope`, `token_type`. Stable per-server and behavioral.
 */

import { redactSensitiveValue } from "../redaction.js";
import type {
  GoldenTrace,
  TraceBody,
  TraceExchange,
  TraceRequest,
  TraceResponse,
} from "./types.js";

/** Bumped when placeholder semantics change, so stale traces are detectable. */
export const NORMALIZER_VERSION = 1;

export const REDACTED = "[REDACTED]";

/**
 * Origin placeholders. Substituted longest-origin-first so an AS hosted on a
 * path under the MCP server's origin cannot be mislabelled.
 */
export type OriginPlaceholders = {
  /** The MCP resource server. */
  mcpServerUrl: string;
  /** The authorization server, when known. */
  authorizationServerUrl?: string;
  /** Additional `placeholder -> origin` pairs, e.g. a CIMD host. */
  extraOrigins?: Record<string, string>;
};

export type NormalizeOptions = OriginPlaceholders & {
  /**
   * Replace trailing version segments in `user-agent` with `{version}`, e.g.
   * `goose/1.4.2` → `goose/{version}`. OFF by default: a UA version change is
   * real drift and HP-38 should see it. Turn it on only when comparing across
   * known-different builds on purpose.
   */
  normalizeVersions?: boolean;
};

// ── Volatility policy ────────────────────────────────────────────────────

/**
 * Params/fields that are secrets. Values are dropped entirely — the redactor
 * is authoritative here, this set exists so query-string and form encodings
 * (which the deep redactor sees only as flat strings) get the same treatment.
 */
const SECRET_KEYS = new Set([
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "code",
  "code_verifier",
  "registration_access_token",
  "authorization",
  "assertion",
  "client_assertion",
]);

/**
 * Params/fields that vary run-to-run but are NOT secrets. Placeheld by name.
 *
 * `shape` controls how much of the value's structure survives:
 *   `"length"`          — length only.
 *   `"length+charset"`  — length and inferred alphabet.
 *
 * Charset is inferred from a SAMPLE, so it is only stable for values whose
 * alphabet is fixed by a spec. `code_challenge` qualifies: RFC 7636 defines it as
 * base64url, so the inference is deterministic and `charset=base64url,len=43`
 * still proves S256 over a 32-byte verifier.
 *
 * `state` and `nonce` do NOT qualify. They are opaque random strings, and whether
 * a given draw happens to contain a character that distinguishes one alphabet
 * from another is chance — inferring charset there made two runs of identical code
 * produce different traces, which is exactly the kind of noise that stops people
 * running a diff. Length only.
 */
const VOLATILE_KEYS: Record<string, { shape?: "length" | "length+charset" }> = {
  state: { shape: "length" },
  nonce: { shape: "length" },
  code_challenge: { shape: "length+charset" },
  client_id_issued_at: {},
  client_secret_expires_at: {},
  session_state: {},
  auth_session: {},
  request_uri: {},
};

/** Response/request headers that change every run and carry no behavior. */
const VOLATILE_HEADERS = new Set([
  "date",
  "expires",
  "last-modified",
  "etag",
  "age",
  "content-length",
  "mcp-session-id",
  "x-request-id",
  "x-correlation-id",
  "x-amzn-requestid",
  "x-amz-cf-id",
  "cf-ray",
  "traceparent",
  "tracestate",
  "x-envoy-upstream-service-time",
  "server-timing",
  "keep-alive",
  "connection",
]);

/** Headers whose values are credentials. */
const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "apikey",
]);

/** JSON body keys holding timestamps. Matched exactly or by `_at` suffix. */
const TIMESTAMP_KEYS = new Set(["iat", "exp", "nbf", "auth_time", "timestamp"]);

function isTimestampKey(key: string): boolean {
  return TIMESTAMP_KEYS.has(key) || key.endsWith("_at");
}

function charsetOf(value: string): string {
  if (/^[A-Za-z0-9\-_]+$/.test(value)) return "base64url";
  if (/^[0-9a-f]+$/i.test(value)) return "hex";
  if (/^[A-Za-z0-9+/]+=*$/.test(value)) return "base64";
  return "mixed";
}

/**
 * Placeholder for a volatile value. Shape-bearing form keeps exactly the two
 * facts that distinguish a conformant PKCE challenge from a broken one.
 */
function placeholder(
  key: string,
  value: string,
  shape?: "length" | "length+charset",
): string {
  if (!shape) return `{${key}}`;
  if (shape === "length") return `{${key}:len=${value.length}}`;
  return `{${key}:len=${value.length},charset=${charsetOf(value)}}`;
}

/**
 * A `client_id` is placeheld UNLESS it is an http(s) URL — under CIMD the
 * client_id is the identity-document URL and is the single most identifying
 * field in the whole handshake.
 */
function normalizeClientId(value: string): string {
  return /^https?:\/\//i.test(value) ? value : "{client_id}";
}

function normalizeScalarField(key: string, value: string): string {
  const lower = key.toLowerCase();

  if (SECRET_KEYS.has(lower)) return REDACTED;
  if (lower === "client_id") return normalizeClientId(value);

  const volatile = VOLATILE_KEYS[lower];
  if (volatile) return placeholder(lower, value, volatile.shape);

  return value;
}

// ── URL normalization ────────────────────────────────────────────────────

/**
 * Loopback hosts whose port is ephemeral in practice. The port is replaced with
 * `{port}` so two runs diff clean; the raw port survives in
 * `observations.dcrIdentity.observedLoopbackPorts`.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/** Extract loopback ports from a list of redirect URIs, in order, deduped. */
export function extractLoopbackPorts(uris: readonly string[]): number[] {
  const ports: number[] = [];
  for (const uri of uris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      continue;
    }
    if (!isLoopbackHost(parsed.hostname) || !parsed.port) continue;
    const port = Number(parsed.port);
    if (Number.isFinite(port) && !ports.includes(port)) ports.push(port);
  }
  return ports;
}

/** Replace a loopback URL's port with `{port}`. Non-loopback URLs pass through. */
export function normalizeLoopbackPort(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (!isLoopbackHost(parsed.hostname) || !parsed.port) return raw;
  // Rebuild by string surgery: URL#port cannot hold a placeholder.
  const authority = `${parsed.hostname}:${parsed.port}`;
  return raw.replace(authority, `${parsed.hostname}:{port}`);
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/**
 * `placeholder -> origin` map, longest origin first so a nested origin cannot
 * shadow its container.
 */
export function buildOriginMap(
  options: OriginPlaceholders,
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const mcp = originOf(options.mcpServerUrl);
  if (mcp) entries.push(["{mcp_server}", mcp]);
  const as = originOf(options.authorizationServerUrl);
  if (as && as !== mcp) entries.push(["{as}", as]);
  for (const [name, origin] of Object.entries(options.extraOrigins ?? {})) {
    const resolved = originOf(origin) ?? origin;
    entries.push([name.startsWith("{") ? name : `{${name}}`, resolved]);
  }
  return entries.sort((left, right) => right[1].length - left[1].length);
}

function substituteOrigins(
  value: string,
  originMap: Array<[string, string]>,
): string {
  let out = value;
  for (const [name, origin] of originMap) {
    if (out.includes(origin)) out = out.split(origin).join(name);
  }
  return out;
}

/**
 * Abstract a URL's origin, THEN placehold any loopback port that remains.
 *
 * The order is load-bearing and the two steps must never be swapped. A test
 * server (and HP-39's CI server) lives on `http://127.0.0.1:<port>`, which is
 * BOTH a scenario origin and a loopback address. Placeholding the port first
 * rewrites the string to `http://127.0.0.1:{port}` — after which the origin no
 * longer matches the scenario's `http://127.0.0.1:3999` and `{mcp_server}` is
 * never substituted at all.
 *
 * Doing it in this order abstracts the SERVER's origin as an origin, and leaves
 * `{port}` for the loopback that genuinely is ephemeral: the client's own
 * redirect URI. Found by pointing the harness at a real loopback server — an
 * https-origin fixture cannot expose it.
 */
function abstractUrl(value: string, originMap: Array<[string, string]>): string {
  return normalizeLoopbackPort(substituteOrigins(value, originMap));
}

export type NormalizedUrl = {
  /** Origin-substituted, volatility-placeheld, query re-serialized in order. */
  url: string;
  /** Multi-valued query params, normalized. Absent when there were none. */
  query?: Record<string, string[]>;
};

/**
 * Normalize a request URL.
 *
 * Query params are returned as a multi-valued map because whether a client
 * sends `resource` once or twice is a real open question — a single-valued map
 * would answer it wrongly and silently.
 */
export function normalizeUrl(
  raw: string,
  options: NormalizeOptions,
): NormalizedUrl {
  const originMap = buildOriginMap(options);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { url: abstractUrl(raw, originMap) };
  }

  const query: Record<string, string[]> = {};
  for (const [key, value] of parsed.searchParams.entries()) {
    // `redirect_uri` is a URL in its own right: normalize its loopback port and
    // origins before applying scalar policy.
    const pre =
      key.toLowerCase() === "redirect_uri"
        ? abstractUrl(value, originMap)
        : substituteOrigins(value, originMap);
    const normalized = normalizeScalarField(key, pre);
    (query[key] ??= []).push(normalized);
  }

  // Canonicalize param ORDER by sorting keys. Param order is not a conformance
  // fact, it is not observable as a client property, and it demonstrably varies
  // between two recordings of the SAME request — so leaving it raw makes
  // identical requests compare unequal. Values WITHIN a key keep their observed
  // order, because a repeated `resource` appearing twice is a real finding.
  const sortedQuery: Record<string, string[]> = {};
  for (const key of Object.keys(query).sort()) sortedQuery[key] = query[key];

  const hasQuery = Object.keys(sortedQuery).length > 0;
  const base = `${parsed.origin}${parsed.pathname}`;
  let url = abstractUrl(base, originMap);

  if (hasQuery) {
    const rendered = Object.entries(sortedQuery)
      .flatMap(([key, values]) => values.map((value) => `${key}=${value}`))
      .join("&");
    url = `${url}?${rendered}`;
  }

  return hasQuery ? { url, query: sortedQuery } : { url };
}

// ── Header normalization ─────────────────────────────────────────────────

function normalizeUserAgent(value: string, options: NormalizeOptions): string {
  if (!options.normalizeVersions) return value;
  return value.replace(/\/\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?/g, "/{version}");
}

export function normalizeHeaders(
  headers: Record<string, string>,
  options: NormalizeOptions,
): Record<string, string> {
  const originMap = buildOriginMap(options);
  const out: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.toLowerCase();

    if (SECRET_HEADERS.has(key)) {
      out[key] = REDACTED;
      continue;
    }
    if (VOLATILE_HEADERS.has(key)) {
      out[key] = `{${key}}`;
      continue;
    }
    if (key === "user-agent") {
      out[key] = normalizeUserAgent(rawValue, options);
      continue;
    }
    // A header whose value IS a URL gets the full URL treatment, not just origin
    // substitution — because its QUERY STRING can carry secrets.
    //
    // The motivating case: a conformant authorization server answers `/authorize`
    // with `302 Location: <redirect_uri>?code=<authorization code>&state=…`. Any
    // proxy or server-side capture of a real host records that header verbatim, so
    // treating it as an opaque string would write a live authorization code into a
    // committed artifact. Routing it through `normalizeUrl` applies the same
    // per-param policy the request side already uses, redacting `code` and
    // placeholding `state`.
    //
    // Found by `assertTraceIsRedacted` firing on the first capture that actually
    // completed an authorize leg — the belt catching what the suspenders missed.
    if (/^https?:\/\//i.test(rawValue.trim())) {
      out[key] = normalizeUrl(rawValue.trim(), options).url;
      continue;
    }

    // `www-authenticate` carries `resource_metadata="<url>"`, which must be
    // origin-substituted or every trace looks host-specific.
    out[key] = substituteOrigins(rawValue, originMap);
  }

  // Sorted: header ORDER is not observable through any HTTP client API we have,
  // so pretending to record it would be a fabricated field.
  return Object.fromEntries(
    Object.entries(out).sort(([left], [right]) => left.localeCompare(right)),
  );
}

// ── Body normalization ───────────────────────────────────────────────────

function normalizeJsonValue(
  value: unknown,
  options: NormalizeOptions,
  originMap: Array<[string, string]>,
  key?: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJsonValue(entry, options, originMap));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        normalizeJsonValue(childValue, options, originMap, childKey),
      ]),
    );
  }

  if (key && isTimestampKey(key) && typeof value === "number") {
    return "{timestamp}";
  }

  if (typeof value === "string") {
    const pre = /^https?:\/\//i.test(value)
      ? abstractUrl(value, originMap)
      : substituteOrigins(value, originMap);
    return key ? normalizeScalarField(key, pre) : pre;
  }

  return value;
}

/**
 * Normalize a body.
 *
 * The deep redactor runs FIRST on structured bodies so that any
 * authorization-shaped key this module has not enumerated is still caught; the
 * volatility pass then runs over the redacted result. Order matters: redaction
 * is the security property and must not depend on this module's key lists being
 * complete.
 */
export function normalizeBody(
  body: TraceBody | undefined,
  options: NormalizeOptions,
): TraceBody | undefined {
  if (!body) return undefined;
  const originMap = buildOriginMap(options);

  if (body.encoding === "opaque") return body;

  if (body.encoding === "form") {
    const fields: Record<string, string[]> = {};
    // Keys sorted for the same reason as query params: field order is not
    // behavioral, and the SDK's own two recordings of one token request differ in
    // it, which would otherwise make a request fail to match itself.
    for (const key of Object.keys(body.fields).sort()) {
      const values = body.fields[key];
      fields[key] = values.map((value) => {
        const pre =
          key.toLowerCase() === "redirect_uri"
            ? abstractUrl(value, originMap)
            : substituteOrigins(value, originMap);
        return normalizeScalarField(key, pre);
      });
    }
    return { encoding: "form", fields };
  }

  const redacted = redactSensitiveValue(body.json);
  const normalized = normalizeJsonValue(redacted, options, originMap);

  if (body.encoding === "jsonrpc") {
    // JSON-RPC `id` is a transport artifact, not behavior.
    const withStableId =
      normalized && typeof normalized === "object" && !Array.isArray(normalized)
        ? { ...(normalized as Record<string, unknown>), ...("id" in (normalized as Record<string, unknown>) ? { id: "{id}" } : {}) }
        : normalized;
    return {
      encoding: "jsonrpc",
      ...(body.method ? { method: body.method } : {}),
      json: withStableId,
    };
  }

  return { encoding: "json", json: normalized };
}

// ── Exchange / trace normalization ───────────────────────────────────────

export function normalizeRequest(
  request: TraceRequest,
  options: NormalizeOptions,
): TraceRequest {
  const { url, query } = normalizeUrl(request.url, options);
  return {
    method: request.method.toUpperCase(),
    url,
    headers: normalizeHeaders(request.headers, options),
    ...(request.headersObserved === false ? { headersObserved: false } : {}),
    ...(query ? { query } : {}),
    ...(request.body ? { body: normalizeBody(request.body, options)! } : {}),
  };
}

export function normalizeResponse(
  response: TraceResponse,
  options: NormalizeOptions,
): TraceResponse {
  return {
    status: response.status,
    ...(response.statusText ? { statusText: response.statusText } : {}),
    headers: normalizeHeaders(response.headers, options),
    ...(response.body ? { body: normalizeBody(response.body, options)! } : {}),
  };
}

export function normalizeExchange(
  exchange: TraceExchange,
  options: NormalizeOptions,
): TraceExchange {
  return {
    ordinal: exchange.ordinal,
    leg: exchange.leg,
    ...(exchange.legBasis ? { legBasis: exchange.legBasis } : {}),
    request: normalizeRequest(exchange.request, options),
    ...(exchange.response
      ? { response: normalizeResponse(exchange.response, options) }
      : {}),
    ...(exchange.error ? { error: exchange.error } : {}),
  };
}

/**
 * Normalize every exchange in a trace and stamp the redaction envelope.
 *
 * `observations` are NOT recomputed here — they are derived from the normalized
 * wire by `./observe.js`, which is the only order that keeps a placeheld value
 * from being read as a real one.
 */
export function normalizeWire(
  wire: readonly TraceExchange[],
  options: NormalizeOptions,
): TraceExchange[] {
  return wire.map((exchange, index) =>
    normalizeExchange({ ...exchange, ordinal: index }, options),
  );
}

// ── Redaction assertion ──────────────────────────────────────────────────

/**
 * Patterns that suggest a live credential survived normalization.
 *
 * Intentionally shape-based rather than key-based: a key-based check would only
 * re-test what `normalizeScalarField` already did, and would pass for a token
 * that leaked through an unexpected key. This is the belt to that suspenders.
 */
const LIVE_SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./ },
  {
    // The `key=` lookahead is load-bearing and mirrors `../redaction.js`: an RFC
    // 6750 CHALLENGE (`WWW-Authenticate: Bearer resource_metadata="…"`) is
    // auth-param syntax, not a credential, and must not be flagged. Without it
    // every PRM-publishing server's 401 trips the assertion.
    name: "Bearer token",
    pattern: /\bBearer\s+(?!\[REDACTED\])(?![A-Za-z_][A-Za-z0-9_-]*=)[A-Za-z0-9\-._~+/]{8,}=*/i,
  },
  {
    name: "authorization-code-shaped value",
    pattern: /\b(?:code|access_token|refresh_token|id_token|client_secret|code_verifier)=(?!\[REDACTED\])[A-Za-z0-9._~-]{16,}/,
  },
];

export type RedactionViolation = {
  path: string;
  pattern: string;
  excerpt: string;
};

/**
 * Scan a trace for anything that looks like a live secret.
 *
 * Called by the capture paths before a trace is written and by the fixture
 * tests, so "traces contain no live secrets" is a mechanically enforced
 * property rather than a review convention.
 */
export function findRedactionViolations(
  trace: unknown,
): RedactionViolation[] {
  const violations: RedactionViolation[] = [];

  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      for (const { name, pattern } of LIVE_SECRET_PATTERNS) {
        const match = pattern.exec(value);
        if (match) {
          violations.push({
            path,
            pattern: name,
            excerpt: `${match[0].slice(0, 24)}…`,
          });
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        walk(child, path ? `${path}.${key}` : key);
      }
    }
  };

  walk(trace, "");
  return violations;
}

/** Throw if a trace still contains anything secret-shaped. */
export function assertTraceIsRedacted(trace: GoldenTrace): void {
  const violations = findRedactionViolations(trace);
  if (violations.length === 0) return;

  const detail = violations
    .map((violation) => `${violation.path}: ${violation.pattern} (${violation.excerpt})`)
    .join("; ");
  throw new Error(
    `Golden trace ${trace.traceId} contains ${violations.length} possible live secret(s) after normalization: ${detail}`,
  );
}
