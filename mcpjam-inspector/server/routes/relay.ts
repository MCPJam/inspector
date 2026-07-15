import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HOSTED_MODE } from "../config.js";
import { getClientIp } from "../utils/client-ip.js";
import { getSystemLogger } from "../utils/request-logger.js";

/**
 * Same-origin PostHog reverse proxy.
 *
 * posthog-js in the client points its api_host at `/relay` on the app origin
 * (see client/src/lib/PosthogUtils.ts). Ad blockers block `*.posthog.com` by
 * hostname, which silently drops 25-40% of web events AND breaks feature-flag
 * evaluation (/flags) for those users; first-party traffic to our own origin
 * passes. This route forwards everything under /relay to PostHog Cloud US,
 * per https://posthog.com/docs/advanced/proxy: static assets go to the assets
 * host, ingest/flags/replay go to the ingest host.
 *
 * Security shape: the route is deliberately OUTSIDE /api so it bypasses
 * session auth (analytics must flow before any session exists — see the note
 * in middleware/session-auth.ts). The upstream hosts are hardcoded constants,
 * never derived from the request, so there is no SSRF surface. Abuse is
 * bounded by path-scoped body limits, a hosted-only per-IP rate limit, and
 * the 30s upstream timeout.
 */

const INGEST_HOST = "https://us.i.posthog.com";
const ASSET_HOST = "https://us-assets.i.posthog.com";
const PROXY_TIMEOUT_MS = 30_000;

// Session-recording batches (/s/) legitimately exceed the default cap;
// events, flags, and asset fetches never come close to it. Keeping the
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

// Inside a sub-app mounted via app.route("/relay", ...), c.req.path is still
// the full request path including the mount prefix. PostHog must receive
// /i/v0/e/, /static/array.js, etc. — never /relay/... — so strip explicitly.
function stripRelayPrefix(path: string): string {
  const stripped = path.startsWith("/relay")
    ? path.slice("/relay".length)
    : path;
  return stripped === "" ? "/" : stripped;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      (error as { code?: string }).code === "ABORT_ERR")
  );
}

const relayRoutes = new Hono();

relayRoutes.all("*", async (c) => {
  const limited = relayRateLimit(c);
  if (limited) {
    return limited;
  }

  stats.requests++;
  const startedAt = Date.now();

  const url = new URL(c.req.url);
  const subpath = stripRelayPrefix(url.pathname);
  // Static assets (recorder.js, array config) live on the assets host; all
  // other endpoints (/i/v0/e/, /flags/, /decide/, /s/) on the ingest host.
  // Unknown subpaths forward to ingest rather than 404ing here: the
  // posthog-js endpoint set changes across SDK versions.
  const upstreamBase =
    subpath.startsWith("/static/") || subpath.startsWith("/array/")
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
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await c.req.arrayBuffer();

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
