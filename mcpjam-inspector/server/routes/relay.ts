import { launchEngagementSchema } from "../../shared/launch-engagement.js";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HOSTED_MODE } from "../config.js";
import { POSTHOG_PROJECT_KEY } from "../utils/analytics.js";
import { getClientIp } from "../utils/client-ip.js";
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
 * bounded by path-scoped body limits, bounded payload reads, a hosted-only
 * per-IP rate limit, and the 30s upstream timeout. Requests are forwarded for
 * our own PostHog project only (see "Project pinning" below).
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
  if (stats.requests === 0) return;
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
  stats.latenciesMs = [];
}

setInterval(flushRelayStats, STATS_FLUSH_INTERVAL_MS).unref();

// ---------------------------------------------------------------------------
// Rate limit (hosted only). Local installs are single-user; hosted is a
// public unauthenticated endpoint. Keyed on getClientIp, whose header
// precedence (cf-connecting-ip > x-real-ip > x-forwarded-for > socket) means
// the key comes from trusted-edge headers on hosted — a client rotating its
// own X-Forwarded-For cannot rotate buckets there because the edge headers
// win. 600/min is ~10x the busiest real posthog-js client.
// ---------------------------------------------------------------------------

const RATE_LIMIT_PER_MIN = 600;
const RATE_WINDOW_MS = 60_000;

const ipWindows = new Map<string, { count: number; windowStart: number }>();

setInterval(
  () => {
    const now = Date.now();
    for (const [ip, entry] of ipWindows) {
      if (now - entry.windowStart > RATE_WINDOW_MS * 2) {
        ipWindows.delete(ip);
      }
    }
  },
  5 * 60_000,
).unref();

function relayRateLimit(c: Context): Response | null {
  if (!HOSTED_MODE) return null;
  const ip = getClientIp(c) ?? "unknown";
  const now = Date.now();
  const entry = ipWindows.get(ip);
  if (entry && now - entry.windowStart < RATE_WINDOW_MS) {
    if (entry.count >= RATE_LIMIT_PER_MIN) {
      stats.rateLimitRejects++;
      return c.json({ error: "rate_limited" }, 429);
    }
    entry.count++;
  } else {
    ipWindows.set(ip, { count: 1, windowStart: now });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Body limit, exported for the mount sites in server/index.ts and
// server/app.ts (both production entries must wire it in front of the route).
// Path-scoped: replay gets the high cap, everything else the low one.
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

const defaultBodyLimit = makeBodyLimit(DEFAULT_MAX_BODY_BYTES);
const replayBodyLimit = makeBodyLimit(REPLAY_MAX_BODY_BYTES);

export function relayBodyLimit() {
  return (c: Context, next: Next) => {
    const subpath = stripRelayPrefix(c.req.path);
    const limiter = subpath.startsWith("/s/")
      ? replayBodyLimit
      : defaultBodyLimit;
    return limiter(c, next);
  };
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

type ProjectCheck = "ours" | "other" | "unreadable";

// Reading a capture payload's tokens means inflating and parsing it, so that
// work is bounded (MJ-015). A gzip body inflates off the event loop, to at
// most INFLATE_RATIO_LIMIT times its compressed size (never below the floor)
// and never past its path's cap. posthog-js flushes a replay batch at about
// 0.9 MiB uncompressed, so real payloads sit well inside these bounds.
const INFLATE_FLOOR_BYTES = 2 * 1024 * 1024;
const INFLATE_RATIO_LIMIT = 32;
const MAX_INFLATED_BODY_BYTES = 8 * 1024 * 1024;
const REPLAY_MAX_INFLATED_BODY_BYTES = 20 * 1024 * 1024;

// Capture payloads are admitted before their bodies are read: a limited
// number at a time, and fewer still of those that may take more than the
// floor to read. Past either limit the relay answers 503, and posthog-js
// retries later.
export const RELAY_MAX_PAYLOAD_CHECKS = 16;
export const RELAY_MAX_LARGE_PAYLOAD_CHECKS = 2;
let payloadChecks = 0;
let largePayloadChecks = 0;

const gunzipAsync = promisify(gunzip);

const TOKEN_QUERY_PARAMS = ["token", "api_key"];
const TOKEN_FIELDS = ["api_key", "token", "$token"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCapturePath(path: string): boolean {
  return /^\/(?:e|i\/v0\/e|s)\/?$/.test(path);
}

// A `data=` value: JSON, or base64-encoded JSON (`compression=base64`).
function parseDataParam(data: string): unknown {
  const trimmed = data.trim();
  const json =
    trimmed.startsWith("{") || trimmed.startsWith("[")
      ? trimmed
      : Buffer.from(trimmed, "base64").toString("utf8");
  return JSON.parse(json);
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

// The most text a capture request's payload can produce, judged from its
// declared length before the body is read; the path's cap when it declares
// none.
function declaredReadBytes(c: Context, subpath: string): number {
  const cap = capturePayloadCap(subpath);
  const declared = Number(c.req.header("content-length"));
  return Number.isSafeInteger(declared) && declared >= 0
    ? inflateBudget(declared, cap)
    : cap;
}

// posthog-js sends gzip (detected by its magic bytes — the SDK drops the
// `compression` query param for gzip), a form-encoded `data=` body, or JSON.
async function parseCapturePayload(
  bytes: Uint8Array,
  cap: number,
): Promise<unknown> {
  const text = (
    isGzip(bytes)
      ? await gunzipAsync(bytes, {
          maxOutputLength: inflateBudget(bytes.length, cap),
        })
      : Buffer.from(bytes)
  )
    .toString("utf8")
    .trimStart();
  if (text.startsWith("{") || text.startsWith("[")) return JSON.parse(text);
  const data = new URLSearchParams(text).get("data");
  if (data === null) throw new Error("no capture payload");
  return parseDataParam(data);
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

async function checkProjectTokens(
  subpath: string,
  url: URL,
  method: string,
  body: ArrayBuffer | undefined,
): Promise<ProjectCheck> {
  const tokens: unknown[] = [];
  for (const param of TOKEN_QUERY_PARAMS) {
    tokens.push(...url.searchParams.getAll(param));
  }
  const configToken = /^\/array\/([^/]+)\/config(?:\.js)?$/.exec(subpath)?.[1];
  if (configToken !== undefined) tokens.push(configToken);

  if (isCapturePath(subpath)) {
    const payloadTokens: unknown[] = [];
    try {
      const payload =
        method === "GET" || method === "HEAD"
          ? parseDataParam(url.searchParams.get("data") ?? "")
          : await parseCapturePayload(
              new Uint8Array(body ?? new ArrayBuffer(0)),
              capturePayloadCap(subpath),
            );
      collectPayloadTokens(payload, payloadTokens);
    } catch {
      return "unreadable";
    }
    if (payloadTokens.length === 0) return "unreadable";
    tokens.push(...payloadTokens);
  }

  if (tokens.length === 0) {
    return subpath.startsWith("/static/") ? "ours" : "unreadable";
  }
  return tokens.every((token) => token === POSTHOG_PROJECT_KEY)
    ? "ours"
    : "other";
}

const relayRoutes = new Hono();

// Anonymous by design, like PostHog capture. Bounded and validated separately
// from the opaque PostHog proxy; never forwards this payload upstream twice.
relayRoutes.post("/launch-engagement", makeBodyLimit(2048), async (c) => {
  const limited = relayRateLimit(c);
  if (limited) return limited;
  const parsed = launchEngagementSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) return c.json({ error: "invalid_launch_event" }, 400);
  getSystemLogger("platform-launch").event("launch.engagement", parsed.data);
  return c.body(null, 204);
});

relayRoutes.all("*", async (c) => {
  const limited = relayRateLimit(c);
  if (limited) {
    return limited;
  }

  stats.requests++;
  const startedAt = Date.now();

  const url = new URL(c.req.url);
  const subpath = stripRelayPrefix(url.pathname);
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
  // Preserve the subpath verbatim (trailing slashes matter to PostHog) and
  // the full query string (compression=gzip-js, ver, ip flags).
  const target = `${upstreamBase}${subpath}${url.search}`;

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

  // Buffer the body (bounded by relayBodyLimit at the mount site) rather
  // than streaming: undici streaming request bodies require duplex:"half"
  // and posthog batches are small enough that buffering is simpler.
  const method = c.req.method;
  const bodyless = method === "GET" || method === "HEAD";
  const readsPayload = !bodyless && isCapturePath(subpath);
  const largePayload =
    readsPayload && declaredReadBytes(c, subpath) > INFLATE_FLOOR_BYTES;
  if (
    readsPayload &&
    (payloadChecks >= RELAY_MAX_PAYLOAD_CHECKS ||
      (largePayload && largePayloadChecks >= RELAY_MAX_LARGE_PAYLOAD_CHECKS))
  ) {
    stats.busyRejects++;
    recordResponseStatus(503);
    c.header("Retry-After", "1");
    return c.json({ error: "relay_busy" }, 503);
  }
  if (readsPayload) payloadChecks++;
  if (largePayload) largePayloadChecks++;
  let body: ArrayBuffer | undefined;
  let project: ProjectCheck;
  try {
    body = bodyless ? undefined : await c.req.arrayBuffer();
    project = await checkProjectTokens(subpath, url, method, body);
  } finally {
    if (readsPayload) payloadChecks--;
    if (largePayload) largePayloadChecks--;
  }
  if (project !== "ours") {
    stats.projectRejects++;
    const status = project === "other" ? 403 : 400;
    recordResponseStatus(status);
    return c.json(
      {
        error:
          project === "other" ? "unsupported_project" : "unreadable_payload",
      },
      status,
    );
  }

  let upstream: Response;
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
