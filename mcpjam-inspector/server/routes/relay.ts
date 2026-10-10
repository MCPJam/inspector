import { launchEngagementSchema } from "../../shared/launch-engagement.js";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HOSTED_MODE } from "../config.js";
import { POSTHOG_PROJECT_KEY } from "../utils/analytics.js";
import { createFixedWindowMap } from "../middleware/passthrough-rate-limit.js";
import {
  edgeAttestationConfigured,
  getAttestedClientIp,
  getClientIp,
  ipRateLimitKey,
} from "../utils/client-ip.js";
import { getSystemLogger } from "../utils/request-logger.js";
import { resolveTelemetryPolicy } from "../services/telemetry-privacy-policy.js";
import {
  applyEventPolicy,
  decideEventPolicies,
  gzipDeclaredBytes,
  isRestricted,
  type PolicyDecision,
  RelayBusyError,
  type RestrictionBudget,
  UnsupportedReplayError,
} from "./relay-privacy.js";

/**
 * Same-origin PostHog reverse proxy.
 *
 * posthog-js in the client points its api_host at `/relay` on the app origin
 * (see client/src/lib/PosthogUtils.ts). Ad blockers block `*.posthog.com` by
 * hostname, which silently drops 25-40% of web events; first-party traffic to
 * our own origin passes. This route forwards supported SDK requests to
 * PostHog Cloud US, per https://posthog.com/docs/advanced/proxy: static
 * assets go to the assets host, ingest/replay go to the ingest host. Feature
 * flags are not relayed: the client gets them from GET /api/web/flags
 * (MJ-015).
 *
 * Security shape: the route is deliberately OUTSIDE /api so it bypasses
 * session auth (analytics must flow before any session exists — see the note
 * in middleware/session-auth.ts). The upstream hosts are hardcoded constants,
 * never derived from the request, so there is no SSRF surface. Abuse is
 * bounded by path-scoped body limits, a body read deadline, buffering
 * budgets, bounded payload reads, hosted-only per-IP rate limits (a coarse
 * one on everything, a tighter one on the ingest subpaths and launch
 * events), and the 30s upstream timeout.
 * Requests are forwarded for our own PostHog project only (see "Project
 * pinning" below).
 *
 * Privacy gate (relay-privacy.ts): every capture event is forwarded under the
 * policy of the context it was captured in, as the backend resolves it for
 * the request's bearer (`Authorization`, set through posthog-js
 * `request_headers`). Restricted events lose names, IP and GeoIP, URL names
 * and autocapture text, and their replay is masked from an allowlist of rrweb
 * structures. No bearer, no stamp, or no answer means the conservative
 * policy. The bearer and the stamp never reach PostHog.
 */

const INGEST_HOST = "https://us.i.posthog.com";
const ASSET_HOST = "https://us-assets.i.posthog.com";
const PROXY_TIMEOUT_MS = 30_000;

// Session-recording batches (/s/) legitimately exceed the default cap;
// events and asset fetches never come close to it. Keeping the
// default small limits what an unauthenticated caller can make us buffer.
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const REPLAY_MAX_BODY_BYTES = 20 * 1024 * 1024;

// Hop-by-hop and app-specific headers that must not reach PostHog. Host is
// derived by fetch() from the target URL; cookie may carry our session;
// accept-encoding is dropped so undici negotiates (and transparently
// decompresses) its own encoding.
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "cookie",
  "connection",
  "content-length",
  "accept-encoding",
  "x-mcp-session-auth",
  "x-mcpjam-edge-secret",
  "x-mcpjam-edge-secret-previous",
  "cf-connecting-ip",
  "cf-ray",
  "x-inspector-service-token",
  "x-mcpjam-guest-ip-hash",
  // The relay bearer: read for the privacy gate, never forwarded.
  "authorization",
  // Client addresses. Only the relay sets one, and only for a capture
  // request whose every event resolved to the full policy.
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "true-client-ip",
  "x-client-ip",
  "x-cluster-client-ip",
  "fastly-client-ip",
]);

// Headers with this prefix carry privacy-context metadata; never forwarded.
const STRIPPED_REQUEST_HEADER_PREFIX = "x-mcpjam-telemetry";

// fetch() already decompressed the body, so the upstream encoding headers
// would corrupt the piped response. Upstream CORS headers are stripped so the
// app-level hono/cors middleware stays authoritative; set-cookie is dropped
// so PostHog can never set cookies on our origin.
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "set-cookie",
  "access-control-allow-origin",
  "access-control-allow-credentials",
]);

// ---------------------------------------------------------------------------
// Observability: low-cardinality aggregate counters, flushed as one system
// log line per interval (never per-request — hosted relay volume would drown
// Axiom). This is the only signal that the relay is up but PostHog is
// rejecting, so keep it accurate: every early return below increments one.
// ---------------------------------------------------------------------------

const STATS_FLUSH_INTERVAL_MS = 60_000;

const relayLogger = getSystemLogger("relay");

const stats = {
  requests: 0,
  res2xx: 0,
  res3xx: 0,
  res4xx: 0,
  res5xx: 0,
  upstream4xx: 0,
  upstream5xx: 0,
  timeouts: 0,
  upstreamErrors: 0,
  bodyLimitRejects: 0,
  rateLimitRejects: 0,
  projectRejects: 0,
  busyRejects: 0,
  // Privacy gate: requests forwarded with at least one restricted event,
  // refused for a payload the gate cannot vouch for, and carrying at least
  // one event whose policy could not be resolved.
  privacyMasked: 0,
  privacyRejected: 0,
  privacyUnresolved: 0,
  latenciesMs: [] as number[],
};

function recordResponseStatus(status: number): void {
  if (status < 300) stats.res2xx++;
  else if (status < 400) stats.res3xx++;
  else if (status < 500) stats.res4xx++;
  else stats.res5xx++;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return Math.round(sorted[Math.max(0, idx)]);
}

export function flushRelayStats(): void {
  if (stats.requests === 0 && stats.rateLimitRejects === 0) return;
  const sorted = [...stats.latenciesMs].sort((a, b) => a - b);
  relayLogger.event("relay.stats", {
    requests: stats.requests,
    res2xx: stats.res2xx,
    res3xx: stats.res3xx,
    res4xx: stats.res4xx,
    res5xx: stats.res5xx,
    upstream4xx: stats.upstream4xx,
    upstream5xx: stats.upstream5xx,
    timeouts: stats.timeouts,
    upstreamErrors: stats.upstreamErrors,
    bodyLimitRejects: stats.bodyLimitRejects,
    rateLimitRejects: stats.rateLimitRejects,
    projectRejects: stats.projectRejects,
    busyRejects: stats.busyRejects,
    privacyMasked: stats.privacyMasked,
    privacyRejected: stats.privacyRejected,
    privacyUnresolved: stats.privacyUnresolved,
    latencyP50Ms: percentile(sorted, 50),
    latencyP95Ms: percentile(sorted, 95),
  });
  stats.requests = 0;
  stats.res2xx = 0;
  stats.res3xx = 0;
  stats.res4xx = 0;
  stats.res5xx = 0;
  stats.upstream4xx = 0;
  stats.upstream5xx = 0;
  stats.timeouts = 0;
  stats.upstreamErrors = 0;
  stats.bodyLimitRejects = 0;
  stats.rateLimitRejects = 0;
  stats.projectRejects = 0;
  stats.busyRejects = 0;
  stats.privacyMasked = 0;
  stats.privacyRejected = 0;
  stats.privacyUnresolved = 0;
  stats.latenciesMs = [];
}

setInterval(flushRelayStats, STATS_FLUSH_INTERVAL_MS).unref();

// ---------------------------------------------------------------------------
// Rate limits (hosted only). Local installs are single-user; hosted is a
// public unauthenticated endpoint. Per-IP budgets require a configured edge
// secret and an attested address. Otherwise callers share a single bucket,
// so client-written ingress headers cannot select a fresh budget. Fixed
// windows from the MJ-012 limiter, two budgets:
//
// - RATE_LIMIT_PER_MIN covers everything the relay serves; 600/min is ~10x
//   the busiest real posthog-js client, mostly asset and config reads.
// - INGEST_LIMIT_PER_MIN covers the requests that write telemetry: the
//   ingest subpaths, which write into the PostHog project (MJ-015), and
//   launch events. posthog-js batches captures and replay slices into a
//   flush every few seconds, so a real browser stays well under one ingest
//   request per second, and 60/min leaves several times that headroom.
//
// Per-client budgets are keyed by the attested address, an IPv6 address by
// its /64 (ipRateLimitKey). Ingest requests without an attested address
// share one bucket, sized by what "unattested" means in this deployment:
//
// - With an edge secret configured, every request through the edge is
//   attested, so the shared bucket only holds traffic that reached the
//   service some other way. It gets the per-client budget, once, for all
//   of that traffic together.
// - Without one, nothing is attested and the shared bucket covers every
//   caller, so it gets the multiple the other pooled windows use
//   (passthrough-rate-limit.ts).
// ---------------------------------------------------------------------------

const RATE_LIMIT_PER_MIN = 600;
export const RELAY_INGEST_LIMIT_PER_MIN = 60;
export const RELAY_UNATTESTED_INGEST_LIMIT_PER_MIN = 60;
export const RELAY_POOLED_INGEST_LIMIT_PER_MIN = 4 * RELAY_INGEST_LIMIT_PER_MIN;
const RATE_WINDOW_MS = 60_000;
const UNATTESTED_CLIENT_KEY = "unattested";

const relayWindows = createFixedWindowMap(RATE_LIMIT_PER_MIN, RATE_WINDOW_MS);
const ingestWindows = createFixedWindowMap(
  RELAY_INGEST_LIMIT_PER_MIN,
  RATE_WINDOW_MS,
);
const unattestedIngestWindows = createFixedWindowMap(
  RELAY_UNATTESTED_INGEST_LIMIT_PER_MIN,
  RATE_WINDOW_MS,
);
const pooledIngestWindows = createFixedWindowMap(
  RELAY_POOLED_INGEST_LIMIT_PER_MIN,
  RATE_WINDOW_MS,
);

// The subpaths that write into the PostHog project: event capture (POST and
// the GET ?data= form), session replay, logs and metrics.
function isIngestSubpath(subpath: string): boolean {
  return /^\/(?:e|i\/v0\/e|s|i\/v1\/(?:logs|metrics))\/?$/.test(subpath);
}

// The attested client's bucket key, or null when there is none.
function attestedClientKey(c: Context): string | null {
  // Without a configured secret, direct-origin callers can forge ingress headers.
  if (!edgeAttestationConfigured()) return null;
  const ip = getAttestedClientIp(c);
  return ip === null ? null : ipRateLimitKey(ip);
}

function relayClientKey(c: Context): string {
  return attestedClientKey(c) ?? UNATTESTED_CLIENT_KEY;
}

function relayRateLimit(c: Context, ingest: boolean): Response | null {
  if (!HOSTED_MODE) return null;
  const clientKey = attestedClientKey(c);
  let refusedMs = relayWindows.charge(clientKey ?? UNATTESTED_CLIENT_KEY);
  if (refusedMs === null && ingest) {
    const sharedWindows = edgeAttestationConfigured()
      ? unattestedIngestWindows
      : pooledIngestWindows;
    refusedMs = clientKey
      ? ingestWindows.charge(clientKey)
      : sharedWindows.charge(UNATTESTED_CLIENT_KEY);
  }
  if (refusedMs === null) return null;
  stats.rateLimitRejects++;
  c.header("Retry-After", String(Math.max(1, Math.ceil(refusedMs / 1000))));
  return c.json({ error: "rate_limited" }, 429);
}

// ---------------------------------------------------------------------------
// Body limit, exported for the mount sites in server/index.ts and
// server/app.ts (both production entries must wire it in front of the route).
// Path-scoped: replay gets the high cap, everything else the low one. The
// mount-site check refuses a body whose declared length is over its cap; the
// route enforces the same cap on the bytes that actually arrive, while it
// reads them (see readRelayBody).
// ---------------------------------------------------------------------------

function makeBodyLimit(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: (c) => {
      stats.bodyLimitRejects++;
      return c.json({ error: "payload_too_large" }, 413);
    },
  });
}

function maxBodyBytes(subpath: string): number {
  return subpath.startsWith("/s/")
    ? REPLAY_MAX_BODY_BYTES
    : DEFAULT_MAX_BODY_BYTES;
}

export function relayBodyLimit() {
  return async (c: Context, next: Next) => {
    const declared = c.req.header("content-length");
    if (
      declared !== undefined &&
      c.req.header("transfer-encoding") === undefined &&
      parseInt(declared, 10) > maxBodyBytes(stripRelayPrefix(c.req.path))
    ) {
      stats.bodyLimitRejects++;
      return c.json({ error: "payload_too_large" }, 413);
    }
    await next();
  };
}

// ---------------------------------------------------------------------------
// Body reads. The route reads each request body itself, so one deadline and
// one size cap cover the whole read: a body must finish arriving within
// RELAY_BODY_READ_TIMEOUT_MS. Bytes count against two buffering budgets as
// they arrive and until the request is forwarded or refused: one for the
// whole relay, and in hosted mode one per client, keyed like the rate limit.
// A read refused for time, size or budget is answered at once and its
// connection closed.
// ---------------------------------------------------------------------------

export const RELAY_BODY_READ_TIMEOUT_MS = 10_000;
export const RELAY_MAX_BUFFERED_BYTES = 128 * 1024 * 1024;
export const RELAY_MAX_CLIENT_BUFFERED_BYTES = 32 * 1024 * 1024;

let bufferedBytes = 0;
const clientBufferedBytes = new Map<string, number>();

type BufferHold = {
  take(bytes: number): boolean;
  release(): void;
};

function bufferHold(clientKey: string | null): BufferHold {
  let held = 0;
  return {
    take(bytes) {
      const client =
        clientKey === null ? 0 : (clientBufferedBytes.get(clientKey) ?? 0);
      if (
        bufferedBytes + bytes > RELAY_MAX_BUFFERED_BYTES ||
        (clientKey !== null && client + bytes > RELAY_MAX_CLIENT_BUFFERED_BYTES)
      ) {
        return false;
      }
      bufferedBytes += bytes;
      held += bytes;
      if (clientKey !== null)
        clientBufferedBytes.set(clientKey, client + bytes);
      return true;
    },
    release() {
      bufferedBytes -= held;
      if (clientKey !== null) {
        const left = (clientBufferedBytes.get(clientKey) ?? 0) - held;
        if (left > 0) clientBufferedBytes.set(clientKey, left);
        else clientBufferedBytes.delete(clientKey);
      }
      held = 0;
    },
  };
}

type BodyRefusal = "timeout" | "too_large" | "busy";

const BODY_READ_TIMED_OUT = Symbol("body read timed out");

async function readRelayBody(
  c: Context,
  maxBytes: number,
  hold: BufferHold,
): Promise<ArrayBuffer | BodyRefusal> {
  const stream = c.req.raw.body;
  if (!stream) return new ArrayBuffer(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof BODY_READ_TIMED_OUT>((resolve) => {
    timer = setTimeout(
      () => resolve(BODY_READ_TIMED_OUT),
      RELAY_BODY_READ_TIMEOUT_MS,
    );
  });
  try {
    for (;;) {
      const read = reader.read();
      const next = await Promise.race([read, deadline]);
      if (next === BODY_READ_TIMED_OUT) {
        // Settles once the connection closes; the result is discarded.
        read.catch(() => {});
        return "timeout";
      }
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) return "too_large";
      if (!hold.take(next.value.byteLength)) return "busy";
      chunks.push(next.value);
    }
  } finally {
    clearTimeout(timer);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function refuseBody(c: Context, refusal: BodyRefusal): Response {
  c.header("Connection", "close");
  if (refusal === "timeout") {
    recordResponseStatus(408);
    return c.json({ error: "relay_body_timeout" }, 408);
  }
  if (refusal === "too_large") {
    stats.bodyLimitRejects++;
    recordResponseStatus(413);
    return c.json({ error: "payload_too_large" }, 413);
  }
  stats.busyRejects++;
  recordResponseStatus(503);
  c.header("Retry-After", "1");
  return c.json({ error: "relay_busy" }, 503);
}

// ---------------------------------------------------------------------------
// The proxy itself.
// ---------------------------------------------------------------------------

// The relay answers on TWO mount prefixes:
//
// - `/relay` — the original mount. Railway's edge (in front of the hosted
//   app; Cloudflare-branded, `x-hikari-trace` on responses) 403s GETs under
//   `/relay/static/*` and `/relay/array/*` while letting the event/flags
//   POSTs through. That silently broke session replay and posthog-js remote
//   config on hosted — the SDK's server-side-enabled flag never arrived, so
//   recording stayed `disabled` even with the recorder code bundled
//   (client/src/lib/posthog-bundled-extensions.ts).
// - `/tlm` — the alias new clients point `api_host` at. Verified against the
//   deployed edge: the block is scoped to the `/relay` prefix (identical
//   subpaths under a decoy prefix pass), and `tlm` is deliberately short and
//   meaningless so it matches no analytics-proxy WAF signature.
//
// `/relay` stays mounted for already-shipped clients (Electron builds pin
// old bundles), whose events still flow through it.
export const RELAY_MOUNT_PREFIXES = ["/relay", "/tlm"] as const;

// Inside a sub-app mounted via app.route(prefix, ...), c.req.path is still
// the full request path including the mount prefix. PostHog must receive
// /i/v0/e/, /static/array.js, etc. — never /relay/... or /tlm/... — so strip
// explicitly.
function stripRelayPrefix(path: string): string {
  for (const prefix of RELAY_MOUNT_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      const stripped = path.slice(prefix.length);
      return stripped === "" ? "/" : stripped;
    }
  }
  return path;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      (error as { code?: string }).code === "ABORT_ERR")
  );
}

function supportsRelayRequest(path: string, method: string): boolean {
  const read = method === "GET" || method === "HEAD";
  if (/^\/(?:e|i\/v0\/e)\/?$/.test(path)) {
    return read || method === "POST";
  }
  if (/^\/(?:s|i\/v1\/(?:logs|metrics))\/?$/.test(path)) {
    return method === "POST";
  }
  if (!read) return false;
  return (
    /^\/array\/[A-Za-z0-9_-]+\/config(?:\.js)?$/.test(path) ||
    /^\/static\/(?:[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?\/)?[A-Za-z0-9_-]+\.js$/.test(
      path,
    ) ||
    /^\/api\/(?:surveys|product_tours|web_experiments|early_access_features)\/$/.test(
      path,
    )
  );
}

// ---------------------------------------------------------------------------
// Project pinning (MJ-015). Every project token a request names — in the
// path, the query string, or the capture payload — must be our own
// POSTHOG_PROJECT_KEY. A capture payload whose tokens cannot be read (an
// unknown encoding, malformed JSON, no token at all) is not forwarded either.
// Only /static assets carry no token.
// ---------------------------------------------------------------------------

type ProjectCheck = "ours" | "other" | "unreadable" | "busy";

// Reading a capture payload's tokens means inflating it and finding its token
// fields, so that work is bounded (MJ-015). A gzip body inflates off the event
// loop, to exactly the size its gzip trailer declares, which may be at most
// INFLATE_RATIO_LIMIT times its compressed size (never below the floor) and
// never past its path's cap. posthog-js flushes a replay batch at about
// 0.9 MiB uncompressed, so real payloads sit well inside these bounds.
const INFLATE_FLOOR_BYTES = 2 * 1024 * 1024;
const INFLATE_RATIO_LIMIT = 32;
const MAX_INFLATED_BODY_BYTES = 8 * 1024 * 1024;
const REPLAY_MAX_INFLATED_BODY_BYTES = 20 * 1024 * 1024;

// One event of a large payload is parsed whole, so an event larger than
// RELAY_MAX_EVENT_BYTES is refused rather than parsed. posthog-js itself
// drops a snapshot event past about 6.3 MB.
export const RELAY_MAX_EVENT_BYTES = 8 * 1024 * 1024;

// A payload of up to RELAY_PARSE_MAX_BYTES is parsed outright. A larger one
// is read by scanning it for its token fields SCAN_SLICE_BYTES at a time,
// yielding to the event loop between slices so other requests are served
// meanwhile.
export const RELAY_PARSE_MAX_BYTES = 64 * 1024;
const SCAN_SLICE_BYTES = 256 * 1024;
const SCAN_MAX_DEPTH = 4096;

// Capture payloads are admitted once their bodies have arrived: a limited
// number are inflated and read at a time, and fewer still of those whose text
// exceeds the floor. Past either limit the relay answers 503, and posthog-js
// retries later. A restricted replay's compressed fields count too: a request
// admitted as small may inflate them to the floor, and past that only under a
// large admission slot.
export const RELAY_MAX_PAYLOAD_CHECKS = 16;
export const RELAY_MAX_LARGE_PAYLOAD_CHECKS = 2;
let payloadChecks = 0;
let largePayloadChecks = 0;

const gunzipAsync = promisify(gunzip);
const gzipAsync = promisify(gzip);

const TOKEN_QUERY_PARAMS = ["token", "api_key"];
const TOKEN_FIELDS = ["api_key", "token", "$token"];
const TOKEN_FIELD_SET = new Set(TOKEN_FIELDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapturePath(path: string): boolean {
  return /^\/(?:e|i\/v0\/e|s)\/?$/.test(path);
}

// A `data=` value: JSON, or base64-encoded JSON (`compression=base64`).
function dataParamBytes(data: string): Buffer {
  const trimmed = data.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[")
    ? Buffer.from(trimmed, "utf8")
    : Buffer.from(trimmed, "base64");
}

function parseDataParam(data: string): unknown {
  return JSON.parse(dataParamBytes(data).toString("utf8"));
}

function capturePayloadCap(subpath: string): number {
  return subpath.startsWith("/s")
    ? REPLAY_MAX_INFLATED_BODY_BYTES
    : MAX_INFLATED_BODY_BYTES;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function inflateBudget(compressedBytes: number, cap: number): number {
  return Math.min(
    cap,
    Math.max(INFLATE_FLOOR_BYTES, compressedBytes * INFLATE_RATIO_LIMIT),
  );
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const COLON = 0x3a;
const COMMA = 0x2c;

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

// The first byte at or after `from` that is not JSON whitespace, looking no
// further than `limit`.
function skipJsonWhitespace(
  bytes: Buffer,
  from: number,
  limit: number,
): number {
  let i = from;
  while (i < limit && isJsonWhitespace(bytes[i])) i++;
  return i;
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
  return -1;
}

// application/x-www-form-urlencoded decoding, as URLSearchParams does it:
// `+` is a space, `%XX` is a byte, and any other `%` stays as it is. Decodes
// from `from` into `out` until `stopAt` (never splitting an escape) and
// returns where it stopped and the decoded length so far.
function formDecodeSpan(
  bytes: Buffer,
  from: number,
  stopAt: number,
  out: Buffer,
  decoded: number,
): [number, number] {
  let i = from;
  let length = decoded;
  for (; i < bytes.length && i < stopAt; i++) {
    const byte = bytes[i];
    if (byte === 0x2b) {
      out[length++] = 0x20;
      continue;
    }
    if (byte === 0x25 && i + 2 < bytes.length) {
      const high = hexValue(bytes[i + 1]);
      const low = hexValue(bytes[i + 2]);
      if (high >= 0 && low >= 0) {
        out[length++] = high * 16 + low;
        i += 2;
        continue;
      }
    }
    out[length++] = byte;
  }
  return [i, length];
}

async function formDecode(bytes: Buffer): Promise<Buffer> {
  const out = Buffer.allocUnsafe(bytes.length);
  let i = 0;
  let length = 0;
  while (i < bytes.length) {
    [i, length] = formDecodeSpan(bytes, i, i + SCAN_SLICE_BYTES, out, length);
    if (i < bytes.length) await yieldToEventLoop();
  }
  return out.subarray(0, length);
}

const DATA_FIELD_NAME = Buffer.from("data");
// A longer name cannot decode to `data`, however it is percent-encoded.
const MAX_FORM_NAME_BYTES = 3 * DATA_FIELD_NAME.length;
// posthog-js sends a single field.
const MAX_FORM_FIELDS = 32;

// The first `data` field of a form body, like URLSearchParams#get("data").
async function formDataParam(body: Buffer): Promise<Buffer | null> {
  let start = 0;
  for (let fields = 0; start < body.length; fields++) {
    if (fields >= MAX_FORM_FIELDS) throw new Error("too many form fields");
    const amp = body.indexOf(0x26, start);
    const end = amp < 0 ? body.length : amp;
    const field = body.subarray(start, end);
    const eq = field.indexOf(0x3d);
    const name = eq < 0 ? field : field.subarray(0, eq);
    if (name.length <= MAX_FORM_NAME_BYTES) {
      const out = Buffer.allocUnsafe(name.length);
      const [, length] = formDecodeSpan(name, 0, name.length, out, 0);
      if (out.subarray(0, length).equals(DATA_FIELD_NAME)) {
        return eq < 0 ? Buffer.alloc(0) : formDecode(field.subarray(eq + 1));
      }
    }
    start = end + 1;
  }
  return null;
}

function collectFieldTokens(
  record: Record<string, unknown>,
  fields: readonly string[],
  tokens: unknown[],
): void {
  for (const field of fields) {
    if (field in record) tokens.push(record[field]);
  }
}

// A single event, an array of events, or `{ api_key, batch: [...] }`.
function collectPayloadTokens(payload: unknown, tokens: unknown[]): void {
  let events: unknown[];
  if (Array.isArray(payload)) {
    events = payload;
  } else if (isRecord(payload) && Array.isArray(payload.batch)) {
    collectFieldTokens(payload, TOKEN_FIELDS, tokens);
    if (isRecord(payload.properties)) {
      collectFieldTokens(payload.properties, ["token"], tokens);
    }
    events = payload.batch;
  } else {
    events = [payload];
  }
  for (const event of events) {
    if (!isRecord(event)) continue;
    collectFieldTokens(event, TOKEN_FIELDS, tokens);
    if (isRecord(event.properties)) {
      collectFieldTokens(event.properties, ["token"], tokens);
    }
  }
}

// ---------------------------------------------------------------------------
// Token scan for payloads over RELAY_PARSE_MAX_BYTES. It validates the JSON
// grammar byte by byte (RFC 8259: string escapes and control characters,
// number syntax, literals, nesting) without building the payload, yielding
// every SCAN_SLICE_BYTES, and records the value at every place
// collectPayloadTokens reads a token from: an event's api_key / token /
// $token and its properties.token, where an event is the payload itself, an
// element of a top-level array, or an element of a top-level `batch` array.
// Every occurrence is recorded, a repeated key included, and a value that is
// not a string is recorded as null so it never matches. Malformed or
// truncated JSON throws.
// ---------------------------------------------------------------------------

const JSON_OBJECT = 1;
const JSON_ARRAY = 2;

// What the grammar expects next, between tokens.
const EXPECT_VALUE = 0;
const EXPECT_VALUE_OR_ARRAY_END = 1;
const EXPECT_KEY = 2;
const EXPECT_KEY_OR_OBJECT_END = 3;
const EXPECT_COLON = 4;
const AFTER_VALUE = 5;

// Where the scan is inside a token.
const IN_NOTHING = 0;
const IN_STRING = 1;
const IN_ESCAPE = 2;
const IN_UNICODE_ESCAPE = 3;
const IN_NUMBER = 4;
const IN_LITERAL = 5;

// Number states: after "-", "0", integer digits, ".", fraction digits, "e",
// the exponent's sign, exponent digits.
const NUMBER_MINUS = 0;
const NUMBER_ZERO = 1;
const NUMBER_INTEGER = 2;
const NUMBER_POINT = 3;
const NUMBER_FRACTION = 4;
const NUMBER_E = 5;
const NUMBER_E_SIGN = 6;
const NUMBER_EXPONENT = 7;

// Keys are only needed down to the deepest token path,
// batch[].properties.token.
const TRACKED_KEY_DEPTH = 4;
// A longer key cannot name a tracked field, however it is escaped.
const MAX_TRACKED_KEY_BYTES = 64;

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

// The next number state for `byte`, or -1 when `byte` does not continue the
// number.
function numberStep(state: number, byte: number): number {
  const digit = isDigit(byte);
  const exponent = byte === 0x65 || byte === 0x45;
  switch (state) {
    case NUMBER_MINUS:
      return byte === 0x30 ? NUMBER_ZERO : digit ? NUMBER_INTEGER : -1;
    case NUMBER_ZERO:
      return byte === 0x2e ? NUMBER_POINT : exponent ? NUMBER_E : -1;
    case NUMBER_INTEGER:
      if (digit) return NUMBER_INTEGER;
      return byte === 0x2e ? NUMBER_POINT : exponent ? NUMBER_E : -1;
    case NUMBER_POINT:
      return digit ? NUMBER_FRACTION : -1;
    case NUMBER_FRACTION:
      return digit ? NUMBER_FRACTION : exponent ? NUMBER_E : -1;
    case NUMBER_E:
      if (byte === 0x2b || byte === 0x2d) return NUMBER_E_SIGN;
      return digit ? NUMBER_EXPONENT : -1;
    case NUMBER_E_SIGN:
    case NUMBER_EXPONENT:
      return digit ? NUMBER_EXPONENT : -1;
    default:
      return -1;
  }
}

function isCompleteNumber(state: number): boolean {
  return (
    state === NUMBER_ZERO ||
    state === NUMBER_INTEGER ||
    state === NUMBER_FRACTION ||
    state === NUMBER_EXPONENT
  );
}

// `"`, `\`, `/`, b, f, n, r, t: the escapes that are not \uXXXX.
function isShortEscape(byte: number): boolean {
  return (
    byte === QUOTE ||
    byte === BACKSLASH ||
    byte === 0x2f ||
    byte === 0x62 ||
    byte === 0x66 ||
    byte === 0x6e ||
    byte === 0x72 ||
    byte === 0x74
  );
}

// The string whose quotes are at `open` and `close`, already validated.
function decodeString(bytes: Buffer, open: number, close: number): string {
  const raw = bytes.subarray(open + 1, close);
  return raw.includes(BACKSLASH)
    ? (JSON.parse(bytes.toString("utf8", open, close + 1)) as string)
    : raw.toString("utf8");
}

// Whether the container at `level` is an event object.
function isEventLevel(kinds: Uint8Array, keys: string[], level: number) {
  if (kinds[level] !== JSON_OBJECT) return false;
  if (level === 0) return true;
  if (level === 1) return kinds[0] === JSON_ARRAY;
  return (
    level === 2 &&
    kinds[0] === JSON_OBJECT &&
    keys[0] === "batch" &&
    kinds[1] === JSON_ARRAY
  );
}

// Whether a value starting inside `depth` open containers sits at a token
// path. keys[level] is the current key of the object at that level.
function isTokenPath(kinds: Uint8Array, keys: string[], depth: number) {
  const parent = depth - 1;
  if (parent < 0 || parent >= TRACKED_KEY_DEPTH) return false;
  if (kinds[parent] !== JSON_OBJECT) return false;
  if (TOKEN_FIELD_SET.has(keys[parent]) && isEventLevel(kinds, keys, parent)) {
    return true;
  }
  return (
    parent >= 1 &&
    keys[parent] === "token" &&
    keys[parent - 1] === "properties" &&
    isEventLevel(kinds, keys, parent - 1)
  );
}

/**
 * Where a scanned payload's events sit, as byte ranges: every event object
 * (`level` 0 for the payload itself, 1 inside a top-level array, 2 inside a
 * top-level `batch` array) and every top-level `batch` array. Lets the relay
 * parse a large payload one event at a time.
 */
export interface PayloadLayout {
  events: Array<{ level: number; start: number; end: number }>;
  batches: Array<{ start: number; end: number }>;
}

// Event objects live at most two containers deep (`batch[]`).
const LAYOUT_DEPTH = 3;

export async function scanPayloadTokens(
  bytes: Buffer,
  tokens: unknown[],
  layout?: PayloadLayout,
): Promise<void> {
  const kinds = new Uint8Array(SCAN_MAX_DEPTH);
  const eventOpenAt = [-1, -1, -1];
  let batchOpenAt = -1;
  const closeContainer = (level: number, end: number) => {
    if (!layout || level >= LAYOUT_DEPTH) return;
    if (kinds[level] === JSON_OBJECT && eventOpenAt[level] >= 0) {
      layout.events.push({ level, start: eventOpenAt[level], end });
      eventOpenAt[level] = -1;
    } else if (kinds[level] === JSON_ARRAY && level === 1 && batchOpenAt >= 0) {
      layout.batches.push({ start: batchOpenAt, end });
      batchOpenAt = -1;
    }
  };
  const keys: string[] = new Array<string>(TRACKED_KEY_DEPTH).fill("");
  let depth = 0;
  let state = EXPECT_VALUE;
  let inside = IN_NOTHING;
  // The open string: where its quote is, whether it is a key, and whether it
  // is a value at a token path.
  let stringOpen = 0;
  let stringIsKey = false;
  let stringIsToken = false;
  let numberState = NUMBER_MINUS;
  let literal = "";
  let literalAt = 0;
  let hexDigitsLeft = 0;
  let nextYield = SCAN_SLICE_BYTES;

  for (let i = 0; i < bytes.length; i++) {
    if (i >= nextYield) {
      await yieldToEventLoop();
      nextYield = i + SCAN_SLICE_BYTES;
    }
    const byte = bytes[i];

    if (inside === IN_STRING) {
      // Plain string bytes, up to the slice end.
      const stop = Math.min(bytes.length, nextYield);
      let j = i;
      while (
        j < stop &&
        bytes[j] !== QUOTE &&
        bytes[j] !== BACKSLASH &&
        bytes[j] >= 0x20
      ) {
        j++;
      }
      if (j === stop) {
        i = j - 1;
        continue;
      }
      i = j;
      const end = bytes[j];
      if (end === BACKSLASH) {
        inside = IN_ESCAPE;
        continue;
      }
      if (end !== QUOTE) throw new Error("control character in a string");
      inside = IN_NOTHING;
      if (stringIsKey) {
        const level = depth - 1;
        if (level < TRACKED_KEY_DEPTH) {
          keys[level] =
            i - stringOpen - 1 <= MAX_TRACKED_KEY_BYTES
              ? decodeString(bytes, stringOpen, i)
              : "";
        }
      } else if (stringIsToken) {
        tokens.push(decodeString(bytes, stringOpen, i));
      }
      continue;
    }
    if (inside === IN_ESCAPE) {
      if (byte === 0x75) {
        inside = IN_UNICODE_ESCAPE;
        hexDigitsLeft = 4;
      } else if (isShortEscape(byte)) {
        inside = IN_STRING;
      } else {
        throw new Error("invalid escape");
      }
      continue;
    }
    if (inside === IN_UNICODE_ESCAPE) {
      if (hexValue(byte) < 0) throw new Error("invalid unicode escape");
      if (--hexDigitsLeft === 0) inside = IN_STRING;
      continue;
    }
    if (inside === IN_LITERAL) {
      if (byte !== literal.charCodeAt(literalAt)) {
        throw new Error("invalid literal");
      }
      if (++literalAt === literal.length) inside = IN_NOTHING;
      continue;
    }
    if (inside === IN_NUMBER) {
      const next = numberStep(numberState, byte);
      if (next >= 0) {
        numberState = next;
        continue;
      }
      if (!isCompleteNumber(numberState)) throw new Error("invalid number");
      // The number has ended; `byte` belongs to the grammar.
      inside = IN_NOTHING;
    }

    if (isJsonWhitespace(byte)) continue;

    if (state === EXPECT_KEY || state === EXPECT_KEY_OR_OBJECT_END) {
      if (state === EXPECT_KEY_OR_OBJECT_END && byte === CLOSE_OBJECT) {
        depth--;
        closeContainer(depth, i + 1);
        state = AFTER_VALUE;
        continue;
      }
      if (byte !== QUOTE) throw new Error("expected a key");
      inside = IN_STRING;
      stringOpen = i;
      stringIsKey = true;
      stringIsToken = false;
      state = EXPECT_COLON;
      continue;
    }

    if (state === EXPECT_COLON) {
      if (byte !== COLON) throw new Error("expected a colon");
      state = EXPECT_VALUE;
      continue;
    }

    if (state === AFTER_VALUE) {
      if (depth === 0) throw new Error("unexpected trailing data");
      const kind = kinds[depth - 1];
      if (byte === COMMA) {
        state = kind === JSON_OBJECT ? EXPECT_KEY : EXPECT_VALUE;
      } else if (
        (byte === CLOSE_OBJECT && kind === JSON_OBJECT) ||
        (byte === CLOSE_ARRAY && kind === JSON_ARRAY)
      ) {
        depth--;
        closeContainer(depth, i + 1);
      } else {
        throw new Error("expected a comma or a closing bracket");
      }
      continue;
    }

    // EXPECT_VALUE or EXPECT_VALUE_OR_ARRAY_END
    if (state === EXPECT_VALUE_OR_ARRAY_END && byte === CLOSE_ARRAY) {
      depth--;
      closeContainer(depth, i + 1);
      state = AFTER_VALUE;
      continue;
    }
    const tokenPath = isTokenPath(kinds, keys, depth);
    if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
      if (tokenPath) tokens.push(null);
      if (depth >= SCAN_MAX_DEPTH) throw new Error("payload nested too deep");
      kinds[depth] = byte === OPEN_OBJECT ? JSON_OBJECT : JSON_ARRAY;
      if (depth < TRACKED_KEY_DEPTH) keys[depth] = "";
      if (layout && depth < LAYOUT_DEPTH) {
        eventOpenAt[depth] =
          byte === OPEN_OBJECT && isEventLevel(kinds, keys, depth) ? i : -1;
        if (
          byte === OPEN_ARRAY &&
          depth === 1 &&
          kinds[0] === JSON_OBJECT &&
          keys[0] === "batch"
        ) {
          batchOpenAt = i;
        }
      }
      depth++;
      state =
        byte === OPEN_OBJECT
          ? EXPECT_KEY_OR_OBJECT_END
          : EXPECT_VALUE_OR_ARRAY_END;
      continue;
    }
    state = AFTER_VALUE;
    if (byte === QUOTE) {
      inside = IN_STRING;
      stringOpen = i;
      stringIsKey = false;
      stringIsToken = tokenPath;
      continue;
    }
    if (tokenPath) tokens.push(null);
    if (byte === 0x2d || isDigit(byte)) {
      inside = IN_NUMBER;
      numberState =
        byte === 0x2d
          ? NUMBER_MINUS
          : byte === 0x30
            ? NUMBER_ZERO
            : NUMBER_INTEGER;
      continue;
    }
    literal =
      byte === 0x74
        ? "true"
        : byte === 0x66
          ? "false"
          : byte === 0x6e
            ? "null"
            : "";
    if (literal === "") throw new Error("unexpected byte");
    inside = IN_LITERAL;
    literalAt = 1;
  }

  if (inside === IN_NUMBER && isCompleteNumber(numberState)) {
    inside = IN_NOTHING;
  }
  if (inside !== IN_NOTHING || state !== AFTER_VALUE || depth !== 0) {
    throw new Error("truncated payload");
  }
}

// ---------------------------------------------------------------------------
// Capture payloads. Decoded once, project-pinned exactly as above, then
// split into events: a payload up to RELAY_PARSE_MAX_BYTES is parsed whole,
// a larger one is scanned (validating it and collecting its tokens) and then
// parsed one event at a time from the ranges the scan recorded, yielding
// between events; an event larger than RELAY_MAX_EVENT_BYTES is refused.
// The privacy gate (relay-privacy.ts) then rewrites each event for its
// policy, and the payload is re-serialized — gzip-compressed for a POST —
// so what PostHog receives is exactly what the relay checked.
// ---------------------------------------------------------------------------

type CaptureShape = "single" | "array" | "batch";

interface CapturePayload {
  shape: CaptureShape;
  /** The batch envelope without its `batch`; only for the batch shape. */
  envelope: Record<string, unknown>;
  events: Record<string, unknown>[];
}

// The same three shapes collectPayloadTokens reads. Non-object entries in an
// event list carry nothing PostHog ingests and are dropped.
function captureShapeOf(payload: unknown): CapturePayload {
  if (Array.isArray(payload)) {
    return { shape: "array", envelope: {}, events: payload.filter(isRecord) };
  }
  if (isRecord(payload) && Array.isArray(payload.batch)) {
    const { batch, ...envelope } = payload;
    return { shape: "batch", envelope, events: batch.filter(isRecord) };
  }
  return {
    shape: "single",
    envelope: {},
    events: isRecord(payload) ? [payload] : [],
  };
}

// posthog-js sends gzip (detected by its magic bytes — the SDK drops the
// `compression` query param for gzip), a form-encoded `data=` body, or JSON.
// Returns the payload's JSON bytes, leading whitespace skipped.
async function decodeCaptureBody(
  bytes: Uint8Array,
  textBytes: number,
): Promise<Buffer> {
  const text = isGzip(bytes)
    ? await gunzipAsync(bytes, { maxOutputLength: Math.max(1, textBytes) })
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const lookahead = Math.min(text.length, SCAN_SLICE_BYTES);
  const start = skipJsonWhitespace(text, 0, lookahead);
  if (
    text[start] === OPEN_OBJECT ||
    text[start] === OPEN_ARRAY ||
    (start === lookahead && start < text.length)
  ) {
    // JSON, or a run of leading whitespace the JSON reader works through.
    return text.subarray(start);
  }
  const data = await formDataParam(text);
  if (data === null) throw new Error("no capture payload");
  return dataParamBytes(data.toString("utf8"));
}

// Parses a large payload from the event ranges its scan recorded.
async function parseByLayout(
  json: Buffer,
  layout: PayloadLayout,
): Promise<CapturePayload> {
  const parseRange = (start: number, end: number): unknown => {
    if (end - start > RELAY_MAX_EVENT_BYTES) throw new Error("event too large");
    return JSON.parse(json.toString("utf8", start, end));
  };
  const root = layout.events.find((event) => event.level === 0);
  if (!root) {
    // A top-level array: its events are the level-1 ranges.
    const events: Record<string, unknown>[] = [];
    for (const event of layout.events) {
      if (event.level !== 1) continue;
      events.push(
        parseRange(event.start, event.end) as Record<string, unknown>,
      );
      await yieldToEventLoop();
    }
    return { shape: "array", envelope: {}, events };
  }
  if (layout.batches.length > 1) throw new Error("ambiguous batch");
  const batch = layout.batches[0];
  if (!batch) {
    return {
      shape: "single",
      envelope: {},
      events: [parseRange(root.start, root.end) as Record<string, unknown>],
    };
  }
  const envelope = JSON.parse(
    `${json.toString("utf8", root.start, batch.start)}[]${json.toString(
      "utf8",
      batch.end,
      root.end,
    )}`,
  ) as Record<string, unknown>;
  delete envelope.batch;
  const events: Record<string, unknown>[] = [];
  for (const event of layout.events) {
    if (event.level !== 2) continue;
    events.push(parseRange(event.start, event.end) as Record<string, unknown>);
    await yieldToEventLoop();
  }
  return { shape: "batch", envelope, events };
}

// Validates the payload, collects its project tokens and splits its events.
async function readCaptureJson(
  json: Buffer,
  tokens: unknown[],
): Promise<CapturePayload> {
  if (json.length <= RELAY_PARSE_MAX_BYTES) {
    const parsed: unknown = JSON.parse(json.toString("utf8"));
    collectPayloadTokens(parsed, tokens);
    return captureShapeOf(parsed);
  }
  const layout: PayloadLayout = { events: [], batches: [] };
  await scanPayloadTokens(json, tokens, layout);
  return await parseByLayout(json, layout);
}

async function serializeCapture(payload: CapturePayload): Promise<string> {
  const parts: string[] = [];
  let pending = 0;
  for (const event of payload.events) {
    const json = JSON.stringify(event);
    parts.push(json);
    pending += json.length;
    if (pending >= SCAN_SLICE_BYTES) {
      pending = 0;
      await yieldToEventLoop();
    }
  }
  const events = parts.join(",");
  if (payload.shape === "array") return `[${events}]`;
  if (payload.shape === "single") return parts[0] ?? "{}";
  const envelope = JSON.stringify(payload.envelope);
  return envelope === "{}"
    ? `{"batch":[${events}]}`
    : `${envelope.slice(0, -1)},"batch":[${events}]}`;
}

function queryTokens(subpath: string, url: URL): unknown[] {
  const tokens: unknown[] = [];
  for (const param of TOKEN_QUERY_PARAMS) {
    tokens.push(...url.searchParams.getAll(param));
  }
  const configToken = /^\/array\/([^/]+)\/config(?:\.js)?$/.exec(subpath)?.[1];
  if (configToken !== undefined) tokens.push(configToken);
  return tokens;
}

// Project pinning for everything that is not a capture payload.
function checkProjectTokens(subpath: string, url: URL): ProjectCheck {
  const tokens = queryTokens(subpath, url);
  if (tokens.length === 0) {
    return subpath.startsWith("/static/") ? "ours" : "unreadable";
  }
  return tokens.every((token) => token === POSTHOG_PROJECT_KEY)
    ? "ours"
    : "other";
}

type CaptureOutcome =
  | { kind: "busy" | "unreadable" | "other" | "unsupported_replay" }
  | {
      kind: "forward";
      /** The rewritten body, gzip-compressed; absent for GET. */
      body: Uint8Array<ArrayBuffer> | undefined;
      /** The rewritten query string, `?` included when not empty. */
      search: string;
      /** Whether any event is restricted. */
      restricted: boolean;
      /** Whether any event's policy could not be resolved. */
      unresolved: boolean;
    };

// The bearer from `Authorization: Bearer <token>`, or null.
function bearerToken(header: string | undefined): string | null {
  const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
  return match ? match[1] : null;
}

// A policy lookup waits on the backend, not the CPU, so it holds no
// admission slot: a request reads its payload under a slot, gives the slot
// back while the backend answers, and is admitted again to rewrite. Waiting
// has bounds of its own: at most RELAY_MAX_POLICY_WAITS requests at once,
// holding at most RELAY_MAX_POLICY_WAIT_BYTES of decoded payload between
// them. Past either the relay answers 503, as it does past admission.
export const RELAY_MAX_POLICY_WAITS = 64;
export const RELAY_MAX_POLICY_WAIT_BYTES = 64 * 1024 * 1024;
let policyWaits = 0;
let policyWaitBytes = 0;

const BUSY = Symbol("busy");

// Runs `work` under an admission slot, a large one too when `large`. The
// budget it gets bounds the request's compressed replay fields, which widen
// to a large slot when they need it. BUSY when no slot is free.
async function admitted<T>(
  large: boolean,
  cap: number,
  work: (budget: RestrictionBudget) => Promise<T>,
): Promise<T | typeof BUSY> {
  if (
    payloadChecks >= RELAY_MAX_PAYLOAD_CHECKS ||
    (large && largePayloadChecks >= RELAY_MAX_LARGE_PAYLOAD_CHECKS)
  ) {
    return BUSY;
  }
  payloadChecks++;
  let holdsLarge = large;
  if (holdsLarge) largePayloadChecks++;
  const budget: RestrictionBudget = {
    inflatedBytesLeft: holdsLarge ? cap : INFLATE_FLOOR_BYTES,
    widen: () => {
      if (holdsLarge) return;
      if (largePayloadChecks >= RELAY_MAX_LARGE_PAYLOAD_CHECKS) {
        throw new RelayBusyError();
      }
      largePayloadChecks++;
      holdsLarge = true;
      budget.inflatedBytesLeft += cap - INFLATE_FLOOR_BYTES;
    },
  };
  try {
    return await work(budget);
  } catch (error) {
    if (error instanceof RelayBusyError) return BUSY;
    throw error;
  } finally {
    payloadChecks--;
    if (holdsLarge) largePayloadChecks--;
  }
}

// Each event's policy, asked of the backend as the request's bearer. Only a
// request with a bearer asks, so only one waits on the budget above.
async function waitForPolicies(
  events: readonly unknown[],
  token: string | null,
  bytes: number,
): Promise<PolicyDecision | typeof BUSY> {
  if (!token) return decideEventPolicies(events, null, resolveTelemetryPolicy);
  if (
    policyWaits >= RELAY_MAX_POLICY_WAITS ||
    policyWaitBytes + bytes > RELAY_MAX_POLICY_WAIT_BYTES
  ) {
    return BUSY;
  }
  policyWaits++;
  policyWaitBytes += bytes;
  try {
    return await decideEventPolicies(events, token, resolveTelemetryPolicy);
  } finally {
    policyWaits--;
    policyWaitBytes -= bytes;
  }
}

// Rewrites each event under its policy and serializes the payload: a POST
// body gzip-compressed the way posthog-js sends it, a GET's `data` as JSON.
async function rewriteCapture(
  url: URL,
  method: string,
  payload: CapturePayload,
  decision: PolicyDecision,
  budget: RestrictionBudget,
): Promise<CaptureOutcome> {
  const events: Record<string, unknown>[] = [];
  try {
    for (let i = 0; i < payload.events.length; i++) {
      events.push(
        (await applyEventPolicy(
          payload.events[i],
          decision.policies[i],
          budget,
        )) as Record<string, unknown>,
      );
    }
  } catch (error) {
    if (error instanceof UnsupportedReplayError) {
      return { kind: "unsupported_replay" };
    }
    throw error;
  }
  const serialized = await serializeCapture({ ...payload, events });
  const isGet = method === "GET" || method === "HEAD";
  const params = new URLSearchParams(url.search);
  if (isGet) {
    params.delete("compression");
    params.set("data", serialized);
  } else {
    params.set("compression", "gzip-js");
  }
  const query = params.toString();
  return {
    kind: "forward",
    body: isGet
      ? undefined
      : new Uint8Array(await gzipAsync(Buffer.from(serialized))),
    search: query ? `?${query}` : "",
    restricted: decision.policies.some(isRestricted),
    unresolved: decision.unresolved > 0,
  };
}

// A capture request end to end: read under an admission slot, decide
// outside one, rewrite under one again.
async function processCapture(
  subpath: string,
  url: URL,
  method: string,
  body: ArrayBuffer | undefined,
  token: string | null,
): Promise<CaptureOutcome> {
  const tokens = queryTokens(subpath, url);
  const payloadTokens: unknown[] = [];
  const pinned = (payload: CapturePayload) => {
    if (payloadTokens.length === 0) return "unreadable" as const;
    return [...tokens, ...payloadTokens].every(
      (candidate) => candidate === POSTHOG_PROJECT_KEY,
    )
      ? payload
      : ("other" as const);
  };

  const isGet = method === "GET" || method === "HEAD";
  const cap = capturePayloadCap(subpath);
  const bytes = new Uint8Array(body ?? new ArrayBuffer(0));
  let textBytes = isGet
    ? (url.searchParams.get("data") ?? "").length
    : bytes.length;
  if (!isGet && isGzip(bytes)) {
    const declared = gzipDeclaredBytes(bytes);
    if (declared === null || declared > inflateBudget(bytes.length, cap)) {
      return { kind: "unreadable" };
    }
    textBytes = declared;
  }
  // A GET's `data` is bounded by the URL, so it is admitted as small.
  const large = !isGet && textBytes > INFLATE_FLOOR_BYTES;

  const read = await admitted(large, cap, async () => {
    let payload: CapturePayload;
    try {
      if (isGet) {
        const parsed = parseDataParam(url.searchParams.get("data") ?? "");
        collectPayloadTokens(parsed, payloadTokens);
        payload = captureShapeOf(parsed);
      } else {
        payload = await readCaptureJson(
          await decodeCaptureBody(bytes, textBytes),
          payloadTokens,
        );
      }
    } catch {
      return "unreadable" as const;
    }
    return pinned(payload);
  });
  if (read === BUSY) return { kind: "busy" };
  if (typeof read === "string") return { kind: read };

  const decision = await waitForPolicies(read.events, token, textBytes);
  if (decision === BUSY) return { kind: "busy" };

  const outcome = await admitted(large, cap, (budget) =>
    rewriteCapture(url, method, read, decision, budget),
  );
  return outcome === BUSY ? { kind: "busy" } : outcome;
}

const relayRoutes = new Hono();

// Anonymous by design, like PostHog capture, and charged to the same ingest
// budget. Bounded and validated separately from the opaque PostHog proxy;
// never forwards this payload upstream twice.
relayRoutes.post("/launch-engagement", makeBodyLimit(2048), async (c) => {
  const limited = relayRateLimit(c, true);
  if (limited) return limited;
  const parsed = launchEngagementSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) return c.json({ error: "invalid_launch_event" }, 400);
  getSystemLogger("platform-launch").event("launch.engagement", parsed.data);
  return c.body(null, 204);
});

relayRoutes.all("*", async (c) => {
  const url = new URL(c.req.url);
  const subpath = stripRelayPrefix(url.pathname);
  const limited = relayRateLimit(c, isIngestSubpath(subpath));
  if (limited) {
    return limited;
  }

  stats.requests++;
  const startedAt = Date.now();

  if (!supportsRelayRequest(subpath, c.req.method)) {
    recordResponseStatus(404);
    return c.json({ error: "not_found" }, 404);
  }
  // Only /static/* goes to the assets host. Everything else — including
  // /array/<token>/config(.js), the SDK's remote-config fetch — goes to the
  // ingest host, which serves it too and is what posthog-js itself targets
  // when unproxied (it derives the config URL from api_host). This matters
  // in production: the assets host 403s our server's egress (Cloudflare in
  // front of us-assets challenging datacenter IPs — the block page our relay
  // then piped through verbatim), while the ingest host demonstrably accepts
  // it (events and flags have always flowed). /static is unaffected in
  // practice: every runtime script is compiled into the client bundle
  // (client/src/lib/posthog-bundled-extensions.ts).
  // Update the supported request set alongside SDK endpoint changes.
  const upstreamBase = subpath.startsWith("/static/")
    ? ASSET_HOST
    : INGEST_HOST;
  const method = c.req.method;

  // Logs carry console output, which the gate can neither mask nor tie to a
  // capture context. The client never enables them; nothing forwards them.
  if (/^\/i\/v1\/logs\/?$/.test(subpath)) {
    stats.privacyRejected++;
    recordResponseStatus(403);
    return c.json({ error: "telemetry_restricted" }, 403);
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(c.req.header())) {
    const name = key.toLowerCase();
    if (
      !STRIPPED_REQUEST_HEADERS.has(name) &&
      !name.startsWith(STRIPPED_REQUEST_HEADER_PREFIX)
    ) {
      headers.set(key, value);
    }
  }
  const token = bearerToken(c.req.header("authorization"));

  // Buffer the body rather than streaming it: undici streaming request
  // bodies require duplex:"half" and posthog batches are small enough that
  // buffering is simpler. readRelayBody bounds the read in time, size and
  // buffered bytes, and only a body that has arrived is admitted for
  // payload checks. The buffered bytes are held until the upstream request
  // settles.
  const hold = bufferHold(HOSTED_MODE ? relayClientKey(c) : null);
  let upstream: Response;
  try {
    let body: ArrayBuffer | Uint8Array<ArrayBuffer> | string | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const read = await readRelayBody(c, maxBodyBytes(subpath), hold);
      if (typeof read === "string") return refuseBody(c, read);
      body = read;
    }

    // Preserve the subpath verbatim (trailing slashes matter to PostHog) and
    // the query string (ver, ip flags); a capture request's is rewritten.
    let search = url.search;
    if (isCapturePath(subpath)) {
      const capture = await processCapture(
        subpath,
        url,
        method,
        body as ArrayBuffer | undefined,
        token,
      );
      if (capture.kind === "busy") {
        stats.busyRejects++;
        recordResponseStatus(503);
        c.header("Retry-After", "1");
        return c.json({ error: "relay_busy" }, 503);
      }
      if (capture.kind === "unsupported_replay") {
        stats.privacyRejected++;
        recordResponseStatus(400);
        return c.json({ error: "unsupported_replay_payload" }, 400);
      }
      if (capture.kind !== "forward") {
        stats.projectRejects++;
        const status = capture.kind === "other" ? 403 : 400;
        recordResponseStatus(status);
        return c.json(
          {
            error:
              capture.kind === "other"
                ? "unsupported_project"
                : "unreadable_payload",
          },
          status,
        );
      }
      if (capture.restricted) stats.privacyMasked++;
      if (capture.unresolved) stats.privacyUnresolved++;
      body = capture.body;
      search = capture.search;
      headers.delete("content-encoding");
      // posthog-js's own shape for a gzip body: `compression=gzip-js` in the
      // query (set above) and a text/plain content type.
      if (body !== undefined) headers.set("Content-Type", "text/plain");
      else headers.delete("content-type");
      // The client's address leaves only with events that all resolved to
      // the full policy; getClientIp prefers the trusted edge headers over
      // anything the client sent itself.
      const clientIp = capture.restricted ? null : getClientIp(c);
      if (clientIp) {
        headers.set("X-Forwarded-For", clientIp);
        headers.set("X-Real-IP", clientIp);
      }
    } else {
      const project = checkProjectTokens(subpath, url);
      if (project !== "ours") {
        stats.projectRejects++;
        const status = project === "other" ? 403 : 400;
        recordResponseStatus(status);
        return c.json(
          {
            error:
              project === "other"
                ? "unsupported_project"
                : "unreadable_payload",
          },
          status,
        );
      }
    }

    // Only /static/* goes to the assets host. Everything else — including
    // /array/<token>/config(.js), the SDK's remote-config fetch — goes to the
    // ingest host, which serves it too and is what posthog-js itself targets
    // when unproxied (it derives the config URL from api_host). This matters
    // in production: the assets host 403s our server's egress (Cloudflare in
    // front of us-assets challenging datacenter IPs — the block page our
    // relay then piped through verbatim), while the ingest host demonstrably
    // accepts it (events and flags have always flowed). /static is
    // unaffected in practice: every runtime script is compiled into the
    // client bundle (client/src/lib/posthog-bundled-extensions.ts).
    // Update the supported request set alongside SDK endpoint changes.
    const target = `${upstreamBase}${subpath}${search}`;
    try {
      upstream = await fetch(target, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
        redirect: "follow",
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        stats.timeouts++;
        stats.res5xx++;
        return c.json({ error: "relay_upstream_timeout" }, 504);
      }
      stats.upstreamErrors++;
      stats.res5xx++;
      return c.json({ error: "relay_upstream_unavailable" }, 502);
    }
  } finally {
    hold.release();
  }

  if (upstream.status >= 500) stats.upstream5xx++;
  else if (upstream.status >= 400) stats.upstream4xx++;

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIPPED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  stats.latenciesMs.push(Date.now() - startedAt);
  recordResponseStatus(upstream.status);

  // Stream the upstream body through (recorder.js is ~300KB).
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
});

export default relayRoutes;
