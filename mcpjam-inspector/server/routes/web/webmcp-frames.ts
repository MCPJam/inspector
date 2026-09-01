/**
 * WebMCP Inspector frame stream over a WebSocket
 * (`GET /api/web/webmcp/sessions/:id/frames`).
 *
 * The pixels half of a frame-stream session. Everything else about the
 * session — status, tools, activity, and the commands that drive it — stays on
 * the SSE stream and the HTTP command route; this carries ONLY painted frames,
 * as binary, and carries them for exactly the reason SSE could not: a JPEG
 * base64'd into a JSON envelope costs a third more bytes, a `JSON.parse` of a
 * quarter-megabyte string per paint, and a second decode on the way to an
 * `<img>`. At 30fps on loopback that tax is most of the perceived lag.
 *
 * WHY `/api/web/` AND WHY A SUBPROTOCOL. `sessionAuthMiddleware` exempts
 * `/api/web/*`, and a browser cannot put a header on a WS handshake — so a
 * route under `/api/mcp/` would 401 every upgrade, and a query-string token
 * would land in access logs. The token therefore rides
 * `Sec-WebSocket-Protocol`, exactly as the two computer terminals do.
 *
 * TRUST MODEL. The token here is the ORDINARY inspector session token — the
 * same one `addTokenToUrl` already puts on the SSE stream — rather than a
 * single-use nonce like the local terminal's. That is a deliberate difference
 * in kind: the terminal opens an interactive shell, while this hands back
 * read-only pixels of a session that same token can already start, drive and
 * close through `/api/mcp/webmcp/*`. A nonce would add ceremony without adding
 * a boundary. The gates, in order:
 *   1. Shutdown latch → 4503 (see `shutdownWebMcpFrameSockets`).
 *   2. `WEBMCP_INSPECTOR_ENABLED` → 4503; the route is additionally mounted
 *      only when `!HOSTED_MODE`, so a hosted replica has no path here at all.
 *   3. `Origin` must be present AND allowlisted → else 4401. As with the
 *      terminals, an ABSENT Origin is refused: browsers always send one on a
 *      handshake, so a client without one has no business opening this.
 *   4. A valid session token in the subprotocol → else 4401.
 *   5. A session that exists → else 4404.
 *
 * Wire protocol:
 *   client → server  text JSON {type:"ping"}
 *   server → client  binary frame   24-byte header + JPEG, see
 *                                   `encodeWebMcpBinaryFrame`
 *   server → client  text JSON {type:"pong"}
 *   server → client  close 4401 unauthorized | 4404 gone | 4503 unavailable
 *
 * No client → server binary, and no commands: input still travels the HTTP
 * command route, which already serializes a gesture's events in order.
 */
import type { UpgradeWebSocket } from "hono/ws";
import type { MiddlewareHandler } from "hono";
import type { WSContext } from "hono/ws";
import { WEBMCP_INSPECTOR_ENABLED } from "../../config.js";
import { isAllowedRequestOrigin } from "../../middleware/origin-validation.js";
import { validateToken } from "../../services/session-token.js";
import { webMcpSessions } from "../../services/webmcp-inspector/session-registry.js";
import { encodeWebMcpBinaryFrame } from "@/shared/webmcp-inspector-protocol";
import { logger } from "../../utils/logger.js";

// Close codes (4xxx = application-defined). The client's ladder branches on
// exactly these, so they are part of the contract: 4401/4503 mean "stop
// trying", 4404 means "this session is over".
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_GONE = 4404;
const CLOSE_UNAVAILABLE = 4503;

/**
 * Replay depth on connect. ONE, because the hub keeps exactly one frame — the
 * current paint — and that is precisely what a connecting socket needs to
 * paint immediately instead of sitting blank until the page next repaints. A
 * settled page may never repaint at all.
 */
const FRAME_REPLAY = 1;

/**
 * Every live frame socket, so shutdown can close them. `server.close()` does
 * NOT drop established sockets, so without this a Ctrl-C leaves browsers
 * streaming into a process that is trying to exit.
 */
const liveSockets = new Set<WSContext<unknown>>();

/**
 * Latched by `shutdownWebMcpFrameSockets()` ONLY — a one-way latch for a
 * terminating process. `killWebMcpFrameSockets()` deliberately does not set
 * it: Electron's `window-all-closed` on macOS closes the server and restarts
 * it on dock activation, and a latch there would refuse every handshake for
 * the rest of the process's life.
 */
let shuttingDown = false;

/**
 * Bumped by every kill. A handshake captures it and re-checks in `onOpen`, so
 * a socket whose upgrade was already in flight when the live set was drained
 * is closed rather than registered — `liveSockets.clear()` cannot see it yet,
 * and nothing else would ever close it.
 */
let socketGeneration = 0;

/** Close every live frame socket, WITHOUT latching. See `socketGeneration`. */
export function killWebMcpFrameSockets(): void {
  socketGeneration += 1;
  for (const ws of liveSockets) {
    try {
      ws.close(CLOSE_UNAVAILABLE, "The inspector is shutting down.");
    } catch {
      // Already gone.
    }
  }
  liveSockets.clear();
}

/**
 * Close every live frame socket and refuse further ones. THE shutdown
 * mechanism for a terminating process. Safe to call repeatedly.
 */
export function shutdownWebMcpFrameSockets(): void {
  shuttingDown = true;
  killWebMcpFrameSockets();
}

/** Test seam: the latch and the live set are module state. */
export function resetWebMcpFramesForTests(): void {
  shuttingDown = false;
  socketGeneration = 0;
  liveSockets.clear();
}

/**
 * Whether a text control message is a ping.
 *
 * Its own function because the interesting case is not the happy one:
 * `JSON.parse("null")` SUCCEEDS and returns `null`, and `typeof null` is
 * `"object"`, so a naive `parsed.type` is a TypeError raised inside a socket
 * `message` handler. Whether that throw is absorbed depends on the adapter,
 * which is not a thing correctness should rest on — and as a plain function
 * the rule is provable without a socket at all.
 */
export function isFramePingMessage(data: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  return (parsed as { type?: unknown }).type === "ping";
}

/** A socket that reports when the OS actually took the bytes. */
interface CallbackSocket {
  send(data: Uint8Array, cb: (error?: Error) => void): void;
}

export interface FramePacer {
  /** Offer an encoded frame. Sent now, or held as the one pending frame. */
  push(bytes: Uint8Array): void;
  /** Stop sending and drop anything held. */
  close(): void;
}

/**
 * Pace frames to what the socket actually drains, holding at most one.
 *
 * CALLBACK-ONLY, with no `bufferedAmount` threshold, and that is the design
 * rather than a simplification. A threshold branch can wedge: the send
 * callback fires while `bufferedAmount` is still above the line, nothing is
 * shipped, and no later event ever wakes the held frame — the pane freezes
 * with the stream healthy. Waiting on the callback bounds kernel-side
 * buffering to a single frame (≤256 KiB by `WEBMCP_FRAME_MAX_BYTES`) with no
 * such branch to get wrong.
 *
 * One pending slot, newest wins — the same philosophy as the SSE route's held
 * frame and the hub's coalesced slot. A queue would make a slow consumer
 * watch an ever-older page; one slot converges it on the current paint.
 */
export function createFramePacer(sink: CallbackSocket): FramePacer {
  let inFlight = false;
  let pending: Uint8Array | undefined;
  let closed = false;

  const ship = (bytes: Uint8Array) => {
    inFlight = true;
    sink.send(bytes, () => {
      inFlight = false;
      if (closed) return;
      const next = pending;
      pending = undefined;
      if (next) ship(next);
    });
  };

  return {
    push(bytes) {
      if (closed) return;
      if (inFlight) {
        // Newest wins: an older frame nobody has seen yet is worth nothing.
        pending = bytes;
        return;
      }
      ship(bytes);
    },
    close() {
      closed = true;
      pending = undefined;
    },
  };
}

/**
 * Adapt a `WSContext` to a callback socket.
 *
 * The node adapter's `raw` is a `ws` WebSocket, whose `send(data, cb)` is the
 * whole point of this route's pacing. When it is absent (a different adapter,
 * or a context that never opened) we fall back to a fire-and-forget send that
 * settles on a microtask: pacing degrades to none, which is worse than
 * self-clocking but is never a wedge.
 */
export function toCallbackSocket(ws: WSContext<unknown>): CallbackSocket {
  const raw = ws.raw as { send?: unknown; terminate?: unknown } | undefined;
  // `terminate` as well as `send`, because `WSContext.raw` is adapter-specific
  // and only node-`ws` promises the completion callback. A platform
  // `send(data)` that silently ignored a second argument would leave the pacer
  // waiting on a callback that never comes — one frame sent, then a pane
  // frozen forever. `terminate` is the Node-only method that tells that
  // adapter apart from a browser-shaped WebSocket, which has send and
  // readyState but not this.
  if (
    raw &&
    typeof raw.send === "function" &&
    typeof raw.terminate === "function"
  ) {
    return raw as unknown as CallbackSocket;
  }
  return {
    send(data, cb) {
      try {
        ws.send(data as never);
      } catch {
        // The socket went away mid-send; the close handler owns cleanup.
      }
      queueMicrotask(() => cb());
    },
  };
}

export function createWebMcpFramesWsHandler(
  upgradeWebSocket: UpgradeWebSocket<
    unknown,
    { onError: (err: unknown) => void }
  >,
): MiddlewareHandler {
  return upgradeWebSocket((c) => {
    // The token rides `Sec-WebSocket-Protocol`: no custom headers on a browser
    // WS handshake, and a query string would land in access logs. No fallback.
    const protocolHeader = c.req.header("sec-websocket-protocol") ?? "";
    const token = protocolHeader.split(",")[0]?.trim() ?? "";
    const origin = c.req.header("Origin");
    const sessionId = c.req.param("id") ?? "";

    // Everything resolvable before the socket opens is resolved here; a
    // failure becomes an immediate close-with-code in `onOpen`, because
    // `createEvents` cannot return an HTTP rejection once the client has asked
    // for an upgrade.
    let rejectCode: number | null = null;
    let rejectMessage = "";

    if (shuttingDown) {
      rejectCode = CLOSE_UNAVAILABLE;
      rejectMessage = "The inspector is shutting down.";
    } else if (!WEBMCP_INSPECTOR_ENABLED) {
      rejectCode = CLOSE_UNAVAILABLE;
      rejectMessage = "The WebMCP Inspector is disabled on this server.";
    } else if (!isAllowedRequestOrigin(origin)) {
      // Defense-in-depth: the global `originValidationMiddleware` already 403s
      // a disallowed Origin pre-upgrade in both entrypoints. This additionally
      // rejects an ABSENT one, and covers an embedding that mounts the route
      // on a bare Hono app.
      rejectCode = CLOSE_UNAUTHORIZED;
      rejectMessage = "Frame requests must come from the inspector UI.";
    } else if (!validateToken(token)) {
      rejectCode = CLOSE_UNAUTHORIZED;
      rejectMessage = "Invalid session token.";
    } else {
      try {
        webMcpSessions.get(sessionId);
      } catch {
        rejectCode = CLOSE_GONE;
        rejectMessage = "That WebMCP session no longer exists.";
      }
    }

    const openGeneration = socketGeneration;
    let unsubscribe: (() => void) | undefined;
    let pacer: FramePacer | undefined;
    let closed = false;

    const teardown = () => {
      closed = true;
      unsubscribe?.();
      unsubscribe = undefined;
      pacer?.close();
      pacer = undefined;
    };

    return {
      onOpen: (_evt, ws) => {
        if (rejectCode !== null) {
          ws.close(rejectCode, rejectMessage.slice(0, 120));
          return;
        }
        if (shuttingDown || openGeneration !== socketGeneration) {
          // Shutdown or a kill swept the live set while this upgrade was in
          // flight; this socket is not in `liveSockets` yet, so nothing else
          // would ever close it.
          ws.close(CLOSE_UNAVAILABLE, "The inspector is shutting down.");
          return;
        }

        let runtime;
        try {
          runtime = webMcpSessions.get(sessionId);
        } catch {
          // Reaped between the handshake and the open.
          ws.close(CLOSE_GONE, "That WebMCP session no longer exists.");
          return;
        }
        // Somebody is watching this page, which is activity: without this a
        // session driven only through the pane would be reaped mid-view.
        webMcpSessions.touch(runtime);

        liveSockets.add(ws);
        const framePacer = createFramePacer(toCallbackSocket(ws));
        pacer = framePacer;

        unsubscribe = runtime.hub.subscribe((event) => {
          if (closed) return;
          if (event.type === "frame") {
            // Base64 → bytes ONCE, here, per send. The in-memory frame stays
            // base64 so the hub and the SSE route are untouched by this
            // transport existing.
            framePacer.push(
              encodeWebMcpBinaryFrame({
                deviceWidth: event.frame.deviceWidth,
                deviceHeight: event.frame.deviceHeight,
                // Forwarded rather than defaulted here: a frame captured at
                // two device pixels per CSS pixel and reported as one would
                // put every click at double its true coordinate.
                ...(event.frame.scale !== undefined
                  ? { scale: event.frame.scale }
                  : {}),
                ts: event.frame.ts,
                seq: event.seq,
                jpeg: Buffer.from(event.frame.data, "base64"),
              }),
            );
            return;
          }
          if (
            event.type === "session" &&
            (event.session.status === "closed" ||
              event.session.status === "error")
          ) {
            // No further paint is ever coming from a closed or crashed
            // browser. Closing says so, rather than leaving a socket that
            // looks live feeding a pane that will never update again; the
            // client's SSE stream carries the reason.
            teardown();
            liveSockets.delete(ws);
            ws.close(CLOSE_GONE, "That WebMCP session is over.");
          }
        }, FRAME_REPLAY);
      },

      onMessage: (evt, ws) => {
        // Text control messages only. This direction carries no input: a
        // gesture's events are ordered by the HTTP command chain, and a second
        // ordering domain would be a second way to get a drag wrong.
        const data = evt.data;
        if (typeof data !== "string") return;
        if (!isFramePingMessage(data)) return;
        // A ping is a viewer saying they are still watching, so it refreshes
        // the idle deadline. Without this a session whose only audience is the
        // pane — no navigation, no invocation, nothing else touching the
        // registry — is reaped out from under someone looking straight at it.
        // Bounded by the client's own 30s cadence, so it cannot be used to
        // hold a session open faster than a real viewer would.
        try {
          webMcpSessions.touch(webMcpSessions.get(sessionId));
        } catch {
          // Already gone; the session-event branch owns the close.
        }
        ws.send(JSON.stringify({ type: "pong" }));
      },

      onClose: (_evt, ws) => {
        liveSockets.delete(ws);
        teardown();
      },

      onError: (evt) => {
        logger.debug("[webmcp-frames] websocket error", {
          event: String((evt as { type?: unknown })?.type ?? "error"),
        });
      },
    };
  });
}
