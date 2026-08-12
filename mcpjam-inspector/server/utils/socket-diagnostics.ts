/**
 * Socket-level failure counters for the HTTP server.
 *
 * Nothing in the server observes socket-level failures today. A connection
 * that dies before Node parses a request line produces no request, no
 * response, and therefore no `http.request.*` event — the request is simply
 * absent from `inspector-logs`. That is the shape of the 2026-08-11 22:15:54
 * incident: the user saw a Cloudflare 502 for `app.mcpjam.com` while this
 * server was healthy and serving ~250 req/min, and no row described it.
 *
 * Without this counter that entire failure class is unfalsifiable in
 * production — we can neither confirm nor rule it out, only speculate. A
 * probe against Railway's proxy found no evidence of stale upstream sockets
 * (48/48 clean, including non-retryable POSTs), which makes one specific
 * theory unlikely but leaves the class itself unmeasured.
 *
 * Aggregated on the `relay.stats` precedent rather than emitted per event:
 * a reset storm must cost one row per flush interval, not one row per socket.
 * Error codes are bucketed to a fixed set so cardinality cannot grow with
 * traffic or with whatever a peer does to us.
 */
import type { Socket } from "node:net";
import { getSystemLogger } from "./request-logger.js";

/**
 * Only the capability we need. `serve()` returns a union of http/https/http2
 * server types, and http2 emits `clientError` with a different socket type —
 * depending on the concrete `node:http` Server would force a cast at the call
 * site for no benefit.
 */
type ClientErrorEmitter = {
  on(
    event: "clientError",
    listener: (err: NodeJS.ErrnoException, socket: Socket) => void,
  ): unknown;
};

const FLUSH_INTERVAL_MS = 60_000;

const socketLogger = getSystemLogger("http.socket");

/**
 * Fixed bucket set. Anything unrecognized becomes `other` — never the raw
 * code — so a peer cannot inflate cardinality by producing novel errors.
 */
type ResetBucket =
  | "econnreset"
  | "epipe"
  | "etimedout"
  | "econnaborted"
  | "parse_error"
  | "header_overflow"
  | "other";

const stats: Record<ResetBucket, number> & { total: number } = {
  econnreset: 0,
  epipe: 0,
  etimedout: 0,
  econnaborted: 0,
  parse_error: 0,
  header_overflow: 0,
  other: 0,
  total: 0,
};

function bucketFor(err: NodeJS.ErrnoException): ResetBucket {
  const code = err?.code ?? "";
  switch (code) {
    case "ECONNRESET":
      return "econnreset";
    case "EPIPE":
      return "epipe";
    case "ETIMEDOUT":
      return "etimedout";
    case "ECONNABORTED":
      return "econnaborted";
    case "HPE_HEADER_OVERFLOW":
      return "header_overflow";
    default:
      // llhttp parse failures all share the HPE_ prefix; collapsing them keeps
      // a malformed-request flood from becoming a wide column set.
      return code.startsWith("HPE_") ? "parse_error" : "other";
  }
}

export function flushSocketStats(): void {
  if (stats.total === 0) return;
  socketLogger.event("http.socket.client_error", {
    total: stats.total,
    econnreset: stats.econnreset,
    epipe: stats.epipe,
    etimedout: stats.etimedout,
    econnaborted: stats.econnaborted,
    parseError: stats.parse_error,
    headerOverflow: stats.header_overflow,
    other: stats.other,
  });
  stats.econnreset = 0;
  stats.epipe = 0;
  stats.etimedout = 0;
  stats.econnaborted = 0;
  stats.parse_error = 0;
  stats.header_overflow = 0;
  stats.other = 0;
  stats.total = 0;
}

/**
 * Reproduces Node's built-in `clientError` response.
 *
 * Attaching any `clientError` listener REPLACES Node's default handling —
 * `_http_server` only runs its own logic when `emit()` reports no listeners.
 * So observing this event means owning the response, and getting it wrong
 * turns a counter into a behaviour change. This mirrors the documented
 * default: 431 for header overflow, 400 otherwise, and an immediate destroy
 * when the socket cannot be written to.
 */
function respondLikeNodeDefault(
  err: NodeJS.ErrnoException,
  socket: Socket,
): void {
  if (!socket.writable || socket.destroyed) {
    socket.destroy();
    return;
  }
  const status =
    err?.code === "HPE_HEADER_OVERFLOW"
      ? "431 Request Header Fields Too Large"
      : "400 Bad Request";
  try {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  } catch {
    // The peer can vanish between the writable check and the write. This
    // handler must never throw: an exception here reaches `uncaughtException`
    // and takes the process down over a dead socket.
    socket.destroy();
  }
}

/**
 * Count socket-level failures on the HTTP server.
 *
 * Safe to call once at startup. Idempotent per server instance.
 */
export function attachSocketDiagnostics(server: ClientErrorEmitter): void {
  server.on("clientError", (err: NodeJS.ErrnoException, socket: Socket) => {
    stats[bucketFor(err)]++;
    stats.total++;
    respondLikeNodeDefault(err, socket);
  });
}

// Unref'd so this timer never holds the process open during shutdown.
setInterval(flushSocketStats, FLUSH_INTERVAL_MS).unref();
