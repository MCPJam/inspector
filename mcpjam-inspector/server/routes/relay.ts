import { launchEngagementSchema } from "../../shared/launch-engagement.js";
import {
  containsCredential,
  scrubCredentialUrl,
  scrubTelemetryValue,
} from "../../shared/credential-urls.js";
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
 * pinning" below), and event, log and replay payloads only once they carry
 * no credential URL (see "Credential scrubbing" below).
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
// decompresses) its own encoding. Referer is the page posthog-js runs on,
// sent in full because the relay is same-origin: on a share link or an OAuth
// callback that URL is the credential (`/results/<token>`, `?code=`), and
// PostHog received it with every request.
const STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "cookie",
  "referer",
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
]);

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
  // Event, log and metric payloads refused because they could not be decoded
  // or scrubbed (too large, malformed, an unknown encoding, a walker failure).
  // Answered 400 like a project rejection, counted apart from one.
  scrubDrops: 0,
  // Replay batches accepted (200) and dropped instead of forwarded: one held
  // a credential, or its nested snapshot data could not be decoded.
  replayCredentialDrops: 0,
  replayUndecodableDrops: 0,
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
  // Built apart from the call: the scrub counters are newer than the
  // `relay.stats` shape declared in utils/log-events.ts, which should list
  // them too.
  const counters = {
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
    scrubDrops: stats.scrubDrops,
    replayCredentialDrops: stats.replayCredentialDrops,
    replayUndecodableDrops: stats.replayUndecodableDrops,
    latencyP50Ms: percentile(sorted, 50),
    latencyP95Ms: percentile(sorted, 95),
  };
  relayLogger.event("relay.stats", counters);
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
  stats.scrubDrops = 0;
  stats.replayCredentialDrops = 0;
  stats.replayUndecodableDrops = 0;
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
//
// Credential scrubbing. No credential URL reaches PostHog through the relay,
// and a payload the relay cannot show to be clean is dropped, never
// forwarded. posthog-js puts the page URL everywhere — `$current_url`,
// `$referrer`, autocapture's element chain, a log's `currentUrl`, a replay's
// meta event — and on a share link or an OAuth callback that URL is the
// credential (shared/credential-urls.ts has the list). The client scrubs
// before it sends; this is the backstop for whatever it missed:
//
// - Events (`/e`, `/i/v0/e`), logs and metrics (`/i/v1/logs`,
//   `/i/v1/metrics`) are decoded whole, every string and key in them goes
//   through the registry's scrubber (`scrubTelemetryValue`), and the result
//   is re-encoded the way it arrived — gzip stays gzip, a base64 form stays a
//   base64 form, a GET `?data=` is rewritten in the query — and forwarded
//   INSTEAD of the client's bytes. Logs and metrics carry the page URL and
//   free text, so they are scrubbed like events rather than passed through.
//   A payload that cannot be decoded, is over RELAY_SCRUB_MAX_TEXT_BYTES, or
//   that the scrubber cannot finish is answered `unreadable_payload` and
//   counted in `scrubDrops`.
// - Replay (`/s`) is never rewritten: a recording with an edited DOM is a
//   corrupt recording, and nothing in it can be cut without breaking the
//   ones around it. A batch that holds a credential anywhere — a property,
//   the meta event's href, a network request's URL, a console line, the DOM
//   and text inside its nested gzip — is answered 200 (posthog-js retries
//   anything else, and the retry would fail the same way) and dropped,
//   counted in `replayCredentialDrops`. A batch whose nested data cannot be
//   decoded cannot be shown clean either: same answer, counted in
//   `replayUndecodableDrops`. A clean batch is forwarded byte for byte.
// ---------------------------------------------------------------------------

// Reading a capture payload means inflating it and reading its JSON, so that
// work is bounded (MJ-015). A gzip body inflates off the event loop, to
// exactly the size its gzip trailer declares, which may be at most
// INFLATE_RATIO_LIMIT times its compressed size (never below the floor) and
// never past its path's cap. posthog-js flushes a replay batch at about
// 0.9 MiB uncompressed, so real payloads sit well inside these bounds.
const INFLATE_FLOOR_BYTES = 2 * 1024 * 1024;
const INFLATE_RATIO_LIMIT = 32;
const REPLAY_MAX_INFLATED_BODY_BYTES = 20 * 1024 * 1024;

// Event, log and metric payloads are rewritten, so they are parsed whole:
// JSON.parse, the scrubber, JSON.stringify — synchronous work, bounded by
// this cap on the JSON text and broken up by a yield every
// SCRUB_YIELD_EVENTS events. 8 MiB of INFLATED text: the body limit's
// 2 MiB applies to the compressed bytes, and a gzip batch of large
// `$exception` stacks or `$set` payloads legitimately inflates several times
// past it. A drop here is a 400 posthog-js does not retry, so the cap sits
// where the relay always allowed event payloads to inflate (the pre-scrub
// MAX_INFLATED_BODY_BYTES). A gzip body that declares more is dropped before
// it is inflated; payloads above the floor are admitted only
// RELAY_MAX_LARGE_PAYLOAD_CHECKS at a time.
export const RELAY_SCRUB_MAX_TEXT_BYTES = 8 * 1024 * 1024;
const SCRUB_YIELD_EVENTS = 64;

// A replay payload is never parsed whole. Its JSON is read by a byte scanner
// SCAN_SLICE_BYTES at a time, yielding to the event loop between slices so
// other requests are served meanwhile, which finds its project tokens and
// hands every string in it to the credential check.
const SCAN_SLICE_BYTES = 256 * 1024;
const SCAN_MAX_DEPTH = 4096;

// posthog-js gzips a replay batch's full snapshots and DOM mutations a second
// time, inside the batch (its `cv: "2024-10"` packing: the gzip bytes as a
// latin1 string). Inspecting a batch means inflating each of those strings
// too; together they may inflate to at most this much per batch, and a batch
// past it is dropped as undecodable. A real batch is about 0.9 MiB as sent,
// and DOM text compresses around tenfold. Each nested string inflates off the
// event loop, and its JSON is read by the same yielding scanner, so the work
// is spread out rather than avoided: a batch carrying a 40k-node full
// snapshot (about 10 MiB inflated) costs roughly 0.6 s of CPU, in turns of
// the event loop no longer than a few tens of milliseconds. The admission
// limits bound how many batches do that at once.
export const RELAY_REPLAY_NESTED_MAX_BYTES = 32 * 1024 * 1024;
// posthog-js nests one level. Gzip found inside nested data is not something
// it produces, and is dropped rather than inflated again.
const REPLAY_MAX_NESTING = 1;

// Capture payloads are admitted once their bodies have arrived: a limited
// number are inflated, read, scrubbed or inspected at a time, and fewer still
// of those whose text exceeds the floor. Past either limit the relay answers
// 503, and posthog-js retries later.
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

// Event capture: POST, and the GET ?data= form.
function isEventPath(path: string): boolean {
  return /^\/(?:e|i\/v0\/e)\/?$/.test(path);
}

function isReplayPath(path: string): boolean {
  return /^\/s\/?$/.test(path);
}

// Logs and metrics: OTLP-shaped JSON whose project is named by `?token=`.
function isOtlpPath(path: string): boolean {
  return /^\/i\/v1\/(?:logs|metrics)\/?$/.test(path);
}

// A `data=` value: JSON, or base64-encoded JSON (`compression=base64`).
function isJsonDataParam(data: string): boolean {
  const trimmed = data.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function dataParamBytes(data: string): Buffer {
  const trimmed = data.trim();
  return isJsonDataParam(trimmed)
    ? Buffer.from(trimmed, "utf8")
    : Buffer.from(trimmed, "base64");
}

// A `data=` value in the encoding the request used.
function encodeDataParam(json: string, form: "json" | "base64"): string {
  return form === "base64"
    ? Buffer.from(json, "utf8").toString("base64")
    : json;
}

function capturePayloadCap(subpath: string): number {
  return isReplayPath(subpath)
    ? REPLAY_MAX_INFLATED_BODY_BYTES
    : RELAY_SCRUB_MAX_TEXT_BYTES;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

// A gzip member is at least a 10-byte header and an 8-byte trailer.
const GZIP_MIN_BYTES = 18;

// The inflated size a gzip body declares in its trailer (ISIZE). Inflation
// is held to exactly this size, so a body that declares less than it holds
// (or holds more than one member) fails to inflate.
function gzipDeclaredBytes(bytes: Uint8Array): number | null {
  if (bytes.length < GZIP_MIN_BYTES) return null;
  return Buffer.from(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).readUInt32LE(bytes.length - 4);
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
// Replay payload scan: how a replay batch, and the JSON nested inside it, is
// read. It validates the JSON grammar byte by byte (RFC 8259: string escapes
// and control characters, number syntax, literals, nesting) without building
// the payload, yielding every SCAN_SLICE_BYTES, and records the value at
// every place
// collectPayloadTokens reads a token from: an event's api_key / token /
// $token and its properties.token, where an event is the payload itself, an
// element of a top-level array, or an element of a top-level `batch` array.
// Every occurrence is recorded, a repeated key included, and a value that is
// not a string is recorded as null so it never matches. Malformed or
// truncated JSON throws.
//
// It also hands every string it reads, keys included, to an optional
// visitor, which is how a replay batch is checked for credentials without
// being built. The visitor may return a promise (a nested gzip string is
// inflated off the event loop); the scan waits for it before going on.
// ---------------------------------------------------------------------------

// The string whose quotes are at `open` and `close` in `bytes`, already
// validated by the scan; `decodeString` reads it.
type StringVisitor = (
  bytes: Buffer,
  open: number,
  close: number,
  isKey: boolean,
) => void | Promise<void>;

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

export async function scanPayloadTokens(
  bytes: Buffer,
  tokens: unknown[],
  visitString?: StringVisitor,
): Promise<void> {
  const kinds = new Uint8Array(SCAN_MAX_DEPTH);
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
      if (visitString) {
        const visiting = visitString(bytes, stringOpen, i, stringIsKey);
        if (visiting) await visiting;
      }
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
      } else {
        throw new Error("expected a comma or a closing bracket");
      }
      continue;
    }

    // EXPECT_VALUE or EXPECT_VALUE_OR_ARRAY_END
    if (state === EXPECT_VALUE_OR_ARRAY_END && byte === CLOSE_ARRAY) {
      depth--;
      state = AFTER_VALUE;
      continue;
    }
    const tokenPath = isTokenPath(kinds, keys, depth);
    if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
      if (tokenPath) tokens.push(null);
      if (depth >= SCAN_MAX_DEPTH) throw new Error("payload nested too deep");
      kinds[depth] = byte === OPEN_OBJECT ? JSON_OBJECT : JSON_ARRAY;
      if (depth < TRACKED_KEY_DEPTH) keys[depth] = "";
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
// Decoding and re-encoding a body.
// ---------------------------------------------------------------------------

// How a body arrived, so a rewritten one leaves the same way. posthog-js
// sends gzip (detected by its magic bytes — the SDK drops the `compression`
// query param for gzip), a form-encoded `data=` body (JSON, or base64 JSON
// with `compression=base64`, which is what sendBeacon uses), or plain JSON.
interface BodyEncoding {
  gzip: boolean;
  /** A `data=` form body and how its value is written; null for bare JSON. */
  form: "json" | "base64" | null;
}

interface DecodedBody {
  json: Buffer;
  encoding: BodyEncoding;
}

// The JSON a body carries, and how it was wrapped. Throws when there is none.
async function decodeBody(
  bytes: Uint8Array,
  textBytes: number,
): Promise<DecodedBody> {
  const gzip = isGzip(bytes);
  const text = gzip
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
    return { json: text.subarray(start), encoding: { gzip, form: null } };
  }
  const data = await formDataParam(text);
  if (data === null) throw new Error("no capture payload");
  const value = data.toString("utf8");
  return {
    json: dataParamBytes(value),
    encoding: { gzip, form: isJsonDataParam(value) ? "json" : "base64" },
  };
}

// `json` wrapped the way `encoding` says. A form body is rebuilt as the one
// `data=` field posthog-js sends; any other field the client added is not
// forwarded, since nothing scrubbed it.
async function encodeBody(
  json: string,
  encoding: BodyEncoding,
): Promise<Uint8Array<ArrayBuffer>> {
  const text =
    encoding.form === null
      ? json
      : `data=${encodeURIComponent(encodeDataParam(json, encoding.form))}`;
  const bytes = Buffer.from(text, "utf8");
  // Both are views of a plain ArrayBuffer (never a SharedArrayBuffer), which
  // is what fetch() takes as a body.
  return (
    encoding.gzip ? await gzipAsync(bytes) : bytes
  ) as Uint8Array<ArrayBuffer>;
}

// The query string with its `data` parameter set to `data`, or removed when
// `data` is null. Every pair URLSearchParams reads as `data` is replaced or
// removed — a second `data=` would be a payload nobody scrubbed — and every
// other pair keeps its spelling, the `compression` flag included.
function withDataParam(search: string, data: string | null): string {
  const body = search.startsWith("?") ? search.slice(1) : search;
  if (body === "") return search;
  const out: string[] = [];
  let written = data === null;
  for (const pair of body.split("&")) {
    if (new URLSearchParams(pair).keys().next().value !== "data") {
      out.push(pair);
    } else if (!written) {
      out.push(`data=${encodeURIComponent(data as string)}`);
      written = true;
    }
  }
  return out.length > 0 ? `?${out.join("&")}` : "";
}

const PROJECT_KEY_SHAPE = /^phc_[A-Za-z0-9]+$/;

/**
 * The query string as forwarded: every parameter but `data` through the
 * credential scrub. `data` is the payload, already scrubbed and re-encoded by
 * the inspection, and must reach PostHog byte for byte. So must `token` when
 * it is a project key (`phc_…`): public by design, and checked against the
 * relay's own project above. PostHog's flags (`compression`, `ver`, `ip`, `_`)
 * carry nothing to scrub and pass as they are. Anything else a client added
 * (`redirect_uri=…`, `code=…`) does not reach PostHog in the clear.
 */
function scrubForwardedSearch(search: string): string {
  const body = search.startsWith("?") ? search.slice(1) : search;
  if (body === "") return search;
  const out = body.split("&").map((pair) => {
    const [[key, value] = ["", ""]] = new URLSearchParams(pair);
    if (key === "data") return pair;
    if (key === "token" && PROJECT_KEY_SHAPE.test(value)) return pair;
    return scrubCredentialUrl(`?${pair}`).slice(1);
  });
  return `?${out.join("&")}`;
}

// The text a body holds once inflated: its own length, or for gzip the size
// its trailer declares. Null when that is more than the path may inflate to,
// or the gzip is too short to be one.
function bodyTextBytes(subpath: string, bytes: Uint8Array): number | null {
  if (!isGzip(bytes)) return bytes.length;
  const declared = gzipDeclaredBytes(bytes);
  if (
    declared === null ||
    declared > inflateBudget(bytes.length, capturePayloadCap(subpath))
  ) {
    return null;
  }
  return declared;
}

// Runs `work` under the admission limits above: it holds a payload slot, and
// a large one when its text is over the floor, until it has read, scrubbed or
// inspected the payload and re-encoded what it forwards.
async function admitted<T>(
  textBytes: number,
  work: () => Promise<T>,
): Promise<T | "busy"> {
  const large = textBytes > INFLATE_FLOOR_BYTES;
  if (
    payloadChecks >= RELAY_MAX_PAYLOAD_CHECKS ||
    (large && largePayloadChecks >= RELAY_MAX_LARGE_PAYLOAD_CHECKS)
  ) {
    return "busy";
  }
  payloadChecks++;
  if (large) largePayloadChecks++;
  try {
    return await work();
  } finally {
    payloadChecks--;
    if (large) largePayloadChecks--;
  }
}

// ---------------------------------------------------------------------------
// Scrubbing events, logs and metrics.
// ---------------------------------------------------------------------------

// One event, every credential out of it. Its project key goes to PostHog as
// it came: by now every key in the payload has been pinned to
// POSTHOG_PROJECT_KEY, which is not a credential URL anyway. The walker
// leaves the event's own api_key / token / $token alone (top-level keys);
// properties.token is a level down, out of its reach, so it is put back.
// THROWS when the walker cannot finish (TelemetryScrubError).
function scrubCaptureEvent(event: unknown): unknown {
  const clean = scrubTelemetryValue(event, {
    preserveTopLevelKeys: TOKEN_FIELDS,
  });
  if (
    isRecord(event) &&
    isRecord(event.properties) &&
    Object.hasOwn(event.properties, "token") &&
    isRecord(clean) &&
    isRecord(clean.properties)
  ) {
    clean.properties.token = event.properties.token;
  }
  return clean;
}

// Each event is walked on its own, so the walker's size limit applies per
// event rather than to the whole batch, and the event loop gets a turn every
// SCRUB_YIELD_EVENTS events.
async function scrubEvents(events: unknown[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const [index, event] of events.entries()) {
    if (index > 0 && index % SCRUB_YIELD_EVENTS === 0) {
      await yieldToEventLoop();
    }
    out.push(scrubCaptureEvent(event));
  }
  return out;
}

// A capture payload in its own shape: an event array, a
// `{ api_key, batch, sent_at }` envelope, or a single event. THROWS when any
// event cannot be scrubbed; the caller drops the payload.
async function scrubCapturePayload(payload: unknown): Promise<unknown> {
  if (Array.isArray(payload)) return scrubEvents(payload);
  if (isRecord(payload) && Array.isArray(payload.batch)) {
    const { batch, ...envelope } = payload;
    const cleanEnvelope = scrubCaptureEvent(envelope) as Record<
      string,
      unknown
    >;
    const cleanBatch = await scrubEvents(batch);
    // Rebuilt in the envelope's own key order, so a payload with nothing to
    // scrub is forwarded as the same JSON text it arrived as. A key the
    // scrubber renamed (one that held a credential) goes last.
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(payload)) {
      if (key === "batch") setOwn(out, key, cleanBatch);
      else if (Object.hasOwn(cleanEnvelope, key)) {
        setOwn(out, key, cleanEnvelope[key]);
      }
    }
    for (const [key, value] of Object.entries(cleanEnvelope)) {
      if (!Object.hasOwn(out, key)) setOwn(out, key, value);
    }
    return out;
  }
  return scrubCaptureEvent(payload);
}

// A plain assignment of a JSON key named `__proto__` would set the object's
// prototype rather than give it the key.
function setOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Inspecting replay batches.
// ---------------------------------------------------------------------------

type ReplayVerdict = "clean" | "credential" | "undecodable";

// fflate's `strFromU8(bytes, true)` writes one character per byte, so a
// nested gzip string starts with the gzip magic as two characters.
function isNestedGzip(value: string): boolean {
  return (
    value.length >= 2 &&
    value.charCodeAt(0) === 0x1f &&
    value.charCodeAt(1) === 0x8b
  );
}

// A character a latin1 byte string cannot hold.
const BEYOND_LATIN1 = /[^\u0000-\u00ff]/;

// A recording repeats itself: every node has the same keys, and tag names,
// class lists and attribute values recur across thousands of nodes (a 40k-node
// snapshot holds about six times as many strings as distinct ones). Short
// strings already checked clean are remembered per batch, up to a total size,
// so each distinct one costs one credential check. Only clean results are
// kept — a credential settles the batch.
const CLEAN_MEMO_MAX_STRING_CHARS = 256;
const CLEAN_MEMO_MAX_TOTAL_CHARS = 4 * 1024 * 1024;

// Reads every string in a replay batch — through the scanner's visitor — for
// a credential. Strings that are nested gzip are inflated and their JSON read
// the same way, so the DOM attributes and text of full snapshots and
// mutations are covered as well as the plain parts (the meta event's href,
// network requests, console lines, properties). One finding settles the
// batch; the scan still runs to the end for the project pinning.
class ReplayInspector {
  verdict: ReplayVerdict = "clean";
  private inflatedBytes = 0;
  private readonly knownClean = new Set<string>();
  private knownCleanChars = 0;

  readonly visit: StringVisitor = (bytes, open, close) =>
    this.inspect(bytes, open, close, 0);

  private inspect(
    bytes: Buffer,
    open: number,
    close: number,
    nesting: number,
  ): void | Promise<void> {
    if (this.verdict !== "clean") return;
    const value = decodeString(bytes, open, close);
    if (isNestedGzip(value)) return this.inspectNested(value, nesting);
    if (!this.isClean(value)) this.verdict = "credential";
  }

  private isClean(value: string): boolean {
    const memo = value.length <= CLEAN_MEMO_MAX_STRING_CHARS;
    if (memo && this.knownClean.has(value)) return true;
    if (containsCredential(value)) return false;
    if (
      memo &&
      this.knownCleanChars + value.length <= CLEAN_MEMO_MAX_TOTAL_CHARS
    ) {
      this.knownClean.add(value);
      this.knownCleanChars += value.length;
    }
    return true;
  }

  private async inspectNested(value: string, nesting: number): Promise<void> {
    if (nesting >= REPLAY_MAX_NESTING || BEYOND_LATIN1.test(value)) {
      this.verdict = "undecodable";
      return;
    }
    let text: Buffer;
    try {
      text = await gunzipAsync(Buffer.from(value, "latin1"), {
        maxOutputLength: Math.max(
          1,
          RELAY_REPLAY_NESTED_MAX_BYTES - this.inflatedBytes,
        ),
      });
    } catch {
      // Not gzip after all, truncated, or past the batch's budget.
      this.verdict = "undecodable";
      return;
    }
    this.inflatedBytes += text.length;
    try {
      await scanPayloadTokens(text, [], (b, o, c) =>
        this.inspect(b, o, c, nesting + 1),
      );
    } catch {
      // Nested data that is not JSON cannot be read for credentials.
      if (this.verdict === "clean") this.verdict = "undecodable";
    }
  }
}

// ---------------------------------------------------------------------------
// What the relay does with a request, decided before anything is forwarded.
// ---------------------------------------------------------------------------

type Inspection =
  /** Forward `body` with `search` as the query string. */
  | {
      kind: "forward";
      body: Uint8Array<ArrayBuffer> | ArrayBuffer | undefined;
      search: string;
    }
  /** Admission is full: 503, and posthog-js retries. */
  | { kind: "busy" }
  /** Names another project: 403. */
  | { kind: "other_project" }
  /** Names no project the relay can read: 400. */
  | { kind: "unreadable" }
  /** Cannot be decoded or scrubbed: 400, never forwarded. */
  | { kind: "scrub_drop" }
  /** A replay batch that is not clean: 200, never forwarded. */
  | { kind: "replay_drop"; reason: Exclude<ReplayVerdict, "clean"> };

const SCRUB_DROP: Inspection = { kind: "scrub_drop" };
const UNREADABLE: Inspection = { kind: "unreadable" };
const OTHER_PROJECT: Inspection = { kind: "other_project" };

// The tokens a request names outside its payload: the query string, and the
// remote-config path.
function requestTokens(subpath: string, url: URL): unknown[] {
  const tokens: unknown[] = [];
  for (const param of TOKEN_QUERY_PARAMS) {
    tokens.push(...url.searchParams.getAll(param));
  }
  const configToken = /^\/array\/([^/]+)\/config(?:\.js)?$/.exec(subpath)?.[1];
  if (configToken !== undefined) tokens.push(configToken);
  return tokens;
}

function pinTokens(tokens: unknown[]): "ours" | "other" | "none" {
  if (tokens.length === 0) return "none";
  return tokens.every((token) => token === POSTHOG_PROJECT_KEY)
    ? "ours"
    : "other";
}

// A capture payload must name a project, and only ours. Null when it does.
function pinCapturePayload(
  payload: unknown,
  tokens: unknown[],
): Inspection | null {
  const payloadTokens: unknown[] = [];
  collectPayloadTokens(payload, payloadTokens);
  if (payloadTokens.length === 0) return UNREADABLE;
  return pinTokens([...tokens, ...payloadTokens]) === "ours"
    ? null
    : OTHER_PROJECT;
}

function parsePayloadJson(json: Buffer): unknown {
  if (json.length > RELAY_SCRUB_MAX_TEXT_BYTES) {
    throw new Error("payload too large to scrub");
  }
  return JSON.parse(json.toString("utf8"));
}

// An event or OTLP payload, scrubbed, as JSON text. THROWS when the walker
// cannot finish.
async function scrubbedJson(
  subpath: string,
  payload: unknown,
): Promise<string> {
  const clean = isEventPath(subpath)
    ? await scrubCapturePayload(payload)
    : scrubTelemetryValue(payload);
  return JSON.stringify(clean);
}

// GET (or HEAD) /e?data=…: the payload is in the query string, and its
// scrubbed copy goes back there, written the way it came.
async function inspectEventQuery(
  subpath: string,
  url: URL,
  tokens: unknown[],
): Promise<Inspection> {
  const data = url.searchParams.get("data");
  if (data === null) return SCRUB_DROP;
  let payload: unknown;
  try {
    payload = parsePayloadJson(dataParamBytes(data));
  } catch {
    return SCRUB_DROP;
  }
  const refusal = pinCapturePayload(payload, tokens);
  if (refusal) return refusal;
  let clean: string;
  try {
    clean = await scrubbedJson(subpath, payload);
  } catch {
    return SCRUB_DROP;
  }
  const form = isJsonDataParam(data) ? "json" : "base64";
  return {
    kind: "forward",
    body: undefined,
    search: withDataParam(url.search, encodeDataParam(clean, form)),
  };
}

// POST to an event, log or metric path: decoded, pinned, scrubbed and
// re-encoded, all under admission.
async function inspectRewrittenBody(
  subpath: string,
  url: URL,
  body: ArrayBuffer | undefined,
  tokens: unknown[],
): Promise<Inspection> {
  const events = isEventPath(subpath);
  if (!events) {
    // Logs and metrics name their project in the query alone, so another
    // project is refused before the body is read.
    const pinned = pinTokens(tokens);
    if (pinned !== "ours")
      return pinned === "other" ? OTHER_PROJECT : UNREADABLE;
  }
  const bytes = new Uint8Array(body ?? new ArrayBuffer(0));
  const textBytes = bodyTextBytes(subpath, bytes);
  if (textBytes === null) return SCRUB_DROP;
  const inspection = await admitted(
    textBytes,
    async (): Promise<Inspection> => {
      let decoded: DecodedBody;
      let payload: unknown;
      try {
        decoded = await decodeBody(bytes, textBytes);
        payload = parsePayloadJson(decoded.json);
      } catch {
        return SCRUB_DROP;
      }
      if (events) {
        const refusal = pinCapturePayload(payload, tokens);
        if (refusal) return refusal;
      }
      try {
        return {
          kind: "forward",
          body: await encodeBody(
            await scrubbedJson(subpath, payload),
            decoded.encoding,
          ),
          // The body is the payload; a `data=` in the query would be a second
          // one that nothing read.
          search: withDataParam(url.search, null),
        };
      } catch {
        return SCRUB_DROP;
      }
    },
  );
  return inspection === "busy" ? { kind: "busy" } : inspection;
}

// POST /s: pinned and inspected in one pass of the scanner, forwarded as it
// came when clean.
async function inspectReplay(
  subpath: string,
  url: URL,
  body: ArrayBuffer | undefined,
  tokens: unknown[],
): Promise<Inspection> {
  const bytes = new Uint8Array(body ?? new ArrayBuffer(0));
  const textBytes = bodyTextBytes(subpath, bytes);
  if (textBytes === null) return UNREADABLE;
  const inspection = await admitted(
    textBytes,
    async (): Promise<Inspection> => {
      const payloadTokens: unknown[] = [];
      const inspector = new ReplayInspector();
      try {
        const { json } = await decodeBody(bytes, textBytes);
        await scanPayloadTokens(json, payloadTokens, inspector.visit);
      } catch {
        return UNREADABLE;
      }
      if (payloadTokens.length === 0) return UNREADABLE;
      if (pinTokens([...tokens, ...payloadTokens]) !== "ours") {
        return OTHER_PROJECT;
      }
      if (inspector.verdict !== "clean") {
        return { kind: "replay_drop", reason: inspector.verdict };
      }
      return { kind: "forward", body, search: url.search };
    },
  );
  return inspection === "busy" ? { kind: "busy" } : inspection;
}

async function inspectRelayRequest(
  subpath: string,
  url: URL,
  method: string,
  body: ArrayBuffer | undefined,
): Promise<Inspection> {
  const tokens = requestTokens(subpath, url);
  const read = method === "GET" || method === "HEAD";
  if (isEventPath(subpath)) {
    return read
      ? inspectEventQuery(subpath, url, tokens)
      : inspectRewrittenBody(subpath, url, body, tokens);
  }
  if (isOtlpPath(subpath)) {
    return inspectRewrittenBody(subpath, url, body, tokens);
  }
  if (isReplayPath(subpath)) return inspectReplay(subpath, url, body, tokens);
  const pinned = pinTokens(tokens);
  if (pinned === "other") return OTHER_PROJECT;
  if (pinned === "none" && !subpath.startsWith("/static/")) return UNREADABLE;
  return { kind: "forward", body, search: url.search };
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

  const headers = new Headers();
  for (const [key, value] of Object.entries(c.req.header())) {
    if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  }
  // Client IP for PostHog geo attribution. getClientIp prefers the trusted
  // edge headers over anything the client sent itself.
  const clientIp = getClientIp(c);
  if (clientIp) {
    headers.set("X-Forwarded-For", clientIp);
    headers.set("X-Real-IP", clientIp);
  }

  // Buffer the body rather than streaming it: undici streaming request
  // bodies require duplex:"half" and posthog batches are small enough that
  // buffering is simpler. readRelayBody bounds the read in time, size and
  // buffered bytes, and only a body that has arrived is admitted for
  // payload checks. The buffered bytes are held until the upstream request
  // settles.
  const method = c.req.method;
  const hold = bufferHold(HOSTED_MODE ? relayClientKey(c) : null);
  let upstream: Response;
  try {
    let body: ArrayBuffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const read = await readRelayBody(c, maxBodyBytes(subpath), hold);
      if (typeof read === "string") return refuseBody(c, read);
      body = read;
    }
    const inspection = await inspectRelayRequest(subpath, url, method, body);
    if (inspection.kind === "busy") {
      stats.busyRejects++;
      recordResponseStatus(503);
      c.header("Retry-After", "1");
      return c.json({ error: "relay_busy" }, 503);
    }
    if (inspection.kind === "replay_drop") {
      if (inspection.reason === "credential") stats.replayCredentialDrops++;
      else stats.replayUndecodableDrops++;
      recordResponseStatus(200);
      // PostHog's own answer to an accepted batch. Anything else and
      // posthog-js retries a batch that would be dropped again.
      return c.json({ status: 1 }, 200);
    }
    if (inspection.kind === "scrub_drop") {
      stats.scrubDrops++;
      recordResponseStatus(400);
      return c.json({ error: "unreadable_payload" }, 400);
    }
    if (inspection.kind !== "forward") {
      stats.projectRejects++;
      const other = inspection.kind === "other_project";
      const status = other ? 403 : 400;
      recordResponseStatus(status);
      return c.json(
        { error: other ? "unsupported_project" : "unreadable_payload" },
        status,
      );
    }

    // Preserve the subpath verbatim (trailing slashes matter to PostHog) and
    // the query string (compression=gzip-js, ver, ip flags) — as the
    // inspection left it: a GET's `?data=` is the scrubbed payload — with
    // every other parameter scrubbed (`scrubForwardedSearch`). The body
    // is the scrubbed, re-encoded payload on the event, log and metric paths;
    // fetch() sets its Content-Length (the client's was stripped above).
    const target = `${upstreamBase}${subpath}${scrubForwardedSearch(inspection.search)}`;
    try {
      upstream = await fetch(target, {
        method,
        headers,
        body: inspection.body,
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
