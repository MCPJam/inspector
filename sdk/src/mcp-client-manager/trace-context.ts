/**
 * W3C trace-context values as they ride MCP `_meta`.
 *
 * The 2026-07-28 spec reserves three `_meta` keys — `traceparent`,
 * `tracestate`, and `baggage` — as an EXCEPTION to the `_meta` prefix rule
 * (they are deliberately NOT under `io.modelcontextprotocol/`, so that MCP
 * matches the OpenTelemetry semantic conventions and existing tracing
 * middleware). The spec's only normative statement about them is a format
 * one: "When present, their values MUST follow W3C Trace Context and W3C
 * Baggage formats respectively." Emitting them at all is a documented
 * convention, not a requirement — a client that has no trace to propagate
 * sends nothing, which is exactly what MCPJam does by default.
 *
 * This module is the format layer, shared by both directions:
 *
 *   - **Outbound** (`TraceContextMetaClient`): a caller-supplied context is
 *     validated here before it is allowed onto the wire. A malformed value is
 *     dropped rather than forwarded — the spec's MUST is about the value, so
 *     propagating garbage would be worse than propagating nothing.
 *
 *   - **Inbound** (debugger surfaces): a trace context observed on a server's
 *     result `_meta` is read back through {@link extractTraceContext} so the
 *     UI can show the user which trace their call joined.
 *
 * **`baggage` is untrusted.** It is arbitrary server- or user-authored
 * key/value data. It is validated for shape and length here and rendered
 * verbatim in the UI, but it MUST NOT be forwarded to analytics
 * (PostHog/Axiom) or any other export path.
 */

/**
 * The three reserved key names, spelled locally rather than imported from
 * `@modelcontextprotocol/client`. This module is reachable from the
 * browser entry, which must stay free of that package's runtime graph (it
 * pulls Node builtins); the names are literal W3C header names, not
 * MCP-prefixed identifiers, so there is nothing to derive. Parity with the
 * upstream `TRACEPARENT_META_KEY` / `TRACESTATE_META_KEY` /
 * `BAGGAGE_META_KEY` constants is asserted in `trace-context.test.ts`.
 */
export const TRACEPARENT_META_KEY = "traceparent";
export const TRACESTATE_META_KEY = "tracestate";
export const BAGGAGE_META_KEY = "baggage";

/**
 * A validated W3C trace context. `traceparent` is the only required member:
 * `tracestate` and `baggage` have no meaning without a parent to attach to,
 * and the spec gives no way to send them alone.
 */
export interface TraceContext {
  /** W3C `traceparent`, e.g. `00-<32 hex>-<16 hex>-01`. */
  traceparent: string;
  /** W3C `tracestate` vendor list, when the caller has one. */
  tracestate?: string;
  /** W3C `baggage` list. UNTRUSTED — display only, never export. */
  baggage?: string;
}

/**
 * Live accessor for the ambient trace context to propagate on outbound
 * requests. Returning `undefined` means "no trace" — no `_meta` keys are
 * injected. Read fresh on every call so a caller whose tracer changes spans
 * per operation gets the current one without reconnecting.
 *
 * MCPJam ships NO implementation of this: we do not run an OpenTelemetry
 * tracer, so the default is "no provider → no keys emitted". The seam exists
 * for SDK embedders that do.
 */
export type TraceContextProvider = (
  serverId: string,
) => TraceContext | undefined;

/** The `version-format` of a `traceparent`, decomposed. */
export interface ParsedTraceparent {
  /** Two lowercase hex digits. `00` is the only version defined today. */
  version: string;
  /** 32 lowercase hex digits, never all-zero. */
  traceId: string;
  /** 16 lowercase hex digits, never all-zero. Also called the parent id. */
  spanId: string;
  /** Two lowercase hex digits of trace-flags. */
  flags: string;
  /** Bit 0 of `flags` — the caller sampled this trace. */
  sampled: boolean;
}

// W3C Trace Context §3.2.2. Lowercase hex only: the spec defines the fields as
// lowercase and says a receiver MUST NOT accept uppercase, so we do not
// normalize — an uppercase value is malformed, not fixable.
const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ALL_ZERO_TRACE_ID = "0".repeat(32);
const ALL_ZERO_SPAN_ID = "0".repeat(16);

/**
 * Parse a `traceparent`, or `undefined` if it is not a valid one.
 *
 * Rejects, per W3C Trace Context §3.2.2.x: a wrong shape, version `ff`
 * (reserved / forbidden), an all-zero trace id, and an all-zero parent id.
 * Versions above `00` are rejected rather than best-effort parsed: the
 * forward-compatible parse rule ("ignore trailing fields") is for RECEIVERS
 * that will mutate and re-emit the header, and we neither mutate nor need it
 * — no such version exists yet.
 */
export function parseTraceparent(
  value: string | undefined,
): ParsedTraceparent | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = TRACEPARENT_RE.exec(value);
  if (!match) {
    return undefined;
  }
  const [, version, traceId, spanId, flags] = match;
  if (version === "ff" || version !== "00") {
    return undefined;
  }
  if (traceId === ALL_ZERO_TRACE_ID || spanId === ALL_ZERO_SPAN_ID) {
    return undefined;
  }
  return {
    version,
    traceId,
    spanId,
    flags,
    sampled: (Number.parseInt(flags, 16) & 0x01) === 0x01,
  };
}

/** Whether `value` is a well-formed `traceparent`. */
export function isValidTraceparent(value: string | undefined): boolean {
  return parseTraceparent(value) !== undefined;
}

// W3C Trace Context §3.3.1: at most 32 list members. A key is either
// `lcalpha (lcalpha | DIGIT | _ | - | * | /){0,255}` or a `tenant@vendor`
// pair; a value is printable ASCII excluding `,` and `=`, up to 256 chars.
const TRACESTATE_MAX_MEMBERS = 32;
const TRACESTATE_KEY_RE =
  /^(?:[a-z][a-z0-9_\-*/]{0,255}|[a-z0-9][a-z0-9_\-*/]{0,240}@[a-z][a-z0-9_\-*/]{0,13})$/;
const TRACESTATE_VALUE_RE = /^[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;

/**
 * Whether `value` is a well-formed `tracestate` list. Empty members are
 * permitted between commas (§3.3.1 allows them for deletion), but a member
 * that is present must be a valid `key=value`.
 */
export function isValidTracestate(value: string | undefined): boolean {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  const members = value.split(",");
  if (members.length > TRACESTATE_MAX_MEMBERS) {
    return false;
  }
  let present = 0;
  for (const raw of members) {
    const member = raw.trim();
    if (member.length === 0) {
      continue;
    }
    present += 1;
    const eq = member.indexOf("=");
    if (eq <= 0) {
      return false;
    }
    if (!TRACESTATE_KEY_RE.test(member.slice(0, eq))) {
      return false;
    }
    if (!TRACESTATE_VALUE_RE.test(member.slice(eq + 1))) {
      return false;
    }
  }
  return present > 0;
}

// W3C Baggage §3.2: at most 180 members and 8192 bytes total. A key is an
// RFC 7230 token; a value is percent-encoded, so printable ASCII excluding
// the delimiters. Properties (`;k=v`) after a value are allowed and passed
// through unparsed — we validate their character set only.
const BAGGAGE_MAX_MEMBERS = 180;
const BAGGAGE_MAX_BYTES = 8192;
const BAGGAGE_KEY_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const BAGGAGE_VALUE_RE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;

/**
 * Whether `value` is a well-formed `baggage` list.
 *
 * Shape and size only — the CONTENT is untrusted by definition. Passing this
 * check says the string is safe to render and to put on the wire; it says
 * nothing about whether the values are safe to log or export (they are not).
 */
export function isValidBaggage(value: string | undefined): boolean {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  if (value.length > BAGGAGE_MAX_BYTES) {
    return false;
  }
  const members = value.split(",");
  if (members.length > BAGGAGE_MAX_MEMBERS) {
    return false;
  }
  for (const raw of members) {
    const member = raw.trim();
    if (member.length === 0) {
      return false;
    }
    const [pair, ...properties] = member.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      return false;
    }
    if (!BAGGAGE_KEY_RE.test(pair.slice(0, eq).trim())) {
      return false;
    }
    if (!BAGGAGE_VALUE_RE.test(pair.slice(eq + 1).trim())) {
      return false;
    }
    for (const property of properties) {
      if (!BAGGAGE_VALUE_RE.test(property.replace(/=/g, "").trim())) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Narrow an arbitrary candidate to the subset of it that is safe to put on
 * the wire, or `undefined` when there is nothing to send.
 *
 * A malformed `traceparent` drops the WHOLE context: `tracestate` and
 * `baggage` describe a trace we would then not be identifying. A malformed
 * `tracestate` or `baggage` drops only itself — the parent is still useful,
 * and the alternative (dropping a valid parent because a vendor list was
 * mangled) loses the more important half.
 */
export function sanitizeTraceContext(
  candidate: TraceContext | undefined,
): TraceContext | undefined {
  if (!candidate || !isValidTraceparent(candidate.traceparent)) {
    return undefined;
  }
  return {
    traceparent: candidate.traceparent,
    ...(isValidTracestate(candidate.tracestate)
      ? { tracestate: candidate.tracestate }
      : {}),
    ...(isValidBaggage(candidate.baggage)
      ? { baggage: candidate.baggage }
      : {}),
  };
}

/**
 * Read a trace context back out of a `_meta` bag (a result's, a request's, a
 * notification's). Same validation as the outbound path, so a server that
 * sends a malformed `traceparent` surfaces as "no trace context" rather than
 * as a bogus trace id in the UI.
 */
export function extractTraceContext(
  meta: Record<string, unknown> | undefined | null,
): TraceContext | undefined {
  if (!meta || typeof meta !== "object") {
    return undefined;
  }
  const read = (key: string): string | undefined => {
    const value = (meta as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  };
  return sanitizeTraceContext({
    traceparent: read(TRACEPARENT_META_KEY) ?? "",
    tracestate: read(TRACESTATE_META_KEY),
    baggage: read(BAGGAGE_META_KEY),
  });
}

/**
 * The `_meta` fragment for a sanitized context: the three reserved keys, each
 * present only when it has a value. Absence is semantic — we never write a
 * key with an empty string.
 */
export function traceContextToMeta(
  context: TraceContext,
): Record<string, string> {
  return {
    [TRACEPARENT_META_KEY]: context.traceparent,
    ...(context.tracestate
      ? { [TRACESTATE_META_KEY]: context.tracestate }
      : {}),
    ...(context.baggage ? { [BAGGAGE_META_KEY]: context.baggage } : {}),
  };
}
