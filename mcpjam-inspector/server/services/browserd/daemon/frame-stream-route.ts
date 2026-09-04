/**
 * `GET /v1/frames` — the daemon's way of getting screencast frames out of its
 * sandbox.
 *
 * Served by the http adapter rather than by `BrowserdRequestHandler`, because a
 * chunked body is not a `DaemonResponse`: the handler's contract is one status
 * and one JSON object, and this route's whole nature is that it keeps writing.
 * It borrows the handler's `authorize` so the gate is the same one, not a
 * second copy that can drift.
 *
 * WHAT MAKES THIS SAFE TO LEAVE OPEN. Three timers, and each exists because of
 * a specific way a one-way stream lies to you:
 *
 *   - The HEARTBEAT re-asks the lease question. `subscribeFrames` revokes on
 *     frame delivery, which is perfect for a page that paints and useless for
 *     one that does not — and "the page is static" is exactly when somebody is
 *     reading it. Without this tick, a person taking the lease over a still
 *     page never evicts the watcher. That is the privacy hole the lease exists
 *     to close, and a transport with no client ping reopens it.
 *   - The same tick asks `stillCurrent()`. A disposed viewport stops calling
 *     its listeners without telling them, so a closed or crashed tab otherwise
 *     reads as a quiet one, forever.
 *   - The STALL WATCHDOG bounds a peer that stops reading. A TCP zero-window or
 *     an edge that goes away never fires the write callback, so the pacer's
 *     in-flight slot never clears — and the subscription behind it keeps
 *     `Page.startScreencast` and a JPEG encoder running on a box the agent is
 *     also trying to use.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  encodeFrameStreamRecord,
  FRAME_STREAM_KIND,
  type FrameStreamEndReason,
} from "../frame-stream";
import { createFramePacer } from "../../webmcp-inspector/frame-pacer";
import type { BrowserdRequestHandler, DaemonRequest } from "./request-handler";

/** How often to prove liveness, re-check the lease, and re-check the tab. */
const HEARTBEAT_MS = 10_000;
/** How long one write may stay unacknowledged before the peer is written off. */
const WRITE_STALL_MS = 15_000;
/**
 * How many streams one daemon will serve.
 *
 * Each holds a viewport subscription (keeping the screencast and its encoder
 * alive) plus an in-flight write of up to 256 KiB. The cap is what stops an
 * abandoned pane from taxing a box the agent is still driving.
 */
const MAX_CONCURRENT_STREAMS = 4;
/** `?probe=1`: how many heartbeats to emit, and how far apart. */
const PROBE_BEATS = 3;
const PROBE_INTERVAL_MS = 1_000;

export interface FrameStreamHost {
  /** Serve one request. Returns false when the caller should 404 it instead. */
  handle(args: {
    req: IncomingMessage;
    res: ServerResponse;
    daemonRequest: DaemonRequest;
  }): boolean;
  /** End every open stream, saying why. Used on shutdown. */
  closeAll(reason: FrameStreamEndReason): void;
  /** Open stream count, for tests and for the cap. */
  count(): number;
}

interface Timers {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface FrameStreamOptions {
  /**
   * How often to prove liveness and re-ask the two questions a one-way stream
   * cannot answer by itself. Injectable because the behaviour it drives — a
   * lease taken over a STATIC page, a tab that went away — is otherwise only
   * observable after ten seconds of real time, which is to say untested.
   */
  heartbeatMs?: number;
  stallMs?: number;
  maxStreams?: number;
  timers?: Timers;
}

export function createFrameStreamHost(
  handler: Pick<BrowserdRequestHandler, "authorize" | "subscribeFrames">,
  options: FrameStreamOptions = {},
): FrameStreamHost {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const stallMs = options.stallMs ?? WRITE_STALL_MS;
  const maxStreams = options.maxStreams ?? MAX_CONCURRENT_STREAMS;
  const timers: Timers = options.timers ?? {
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const open = new Set<{ end: (reason: FrameStreamEndReason) => void }>();

  function handle(args: {
    req: IncomingMessage;
    res: ServerResponse;
    daemonRequest: DaemonRequest;
  }): boolean {
    const { req, res, daemonRequest } = args;

    const refusal = handler.authorize(daemonRequest);
    if (refusal) {
      writeJson(res, refusal.status, refusal.body);
      return true;
    }
    if (daemonRequest.method !== "GET") {
      // Answered here rather than falling through to the handler's catch-all:
      // a route whose 405 came from a different file would be a contract split
      // across two places, and the next reader would find only half of it.
      res.writeHead(405, { allow: "GET" });
      res.end();
      return true;
    }
    if (open.size >= maxStreams) {
      writeJson(res, 503, { error: "too_many_watchers" });
      return true;
    }

    // A GET may still arrive with a body, and the adapter only drains POST/PUT.
    // Left unread, Node never releases the socket.
    req.resume();

    const query = daemonRequest.query;
    const tabId = query?.get("tabId") ?? undefined;
    const holder = query?.get("holder") ?? undefined;
    const probe = query?.get("probe") === "1";

    beginStream(res);
    if (probe) {
      runProbe(res);
      return true;
    }

    // The SAME hazard as the heartbeat's, one await earlier: `subscribeFrames`
    // resolves a viewport, and resolving one opens a tab and attaches a CDP
    // session — either of which throws on a closing context or a crashed
    // renderer, and `ChromiumDriver` caches the rejected promise so every
    // later caller inherits it. Unhandled, that ends the daemon process. Left
    // merely unfinished it is nearly as bad: the response never ends and its
    // entry holds one of four cap slots until the client gives up.
    void startSubscription({ res, tabId, holder }).catch(() => {
      writeEndAndClose(res, "tab_gone");
    });
    return true;
  }

  /**
   * Last-resort close for a stream that failed before it had its own `end`.
   *
   * Writes the same in-band reason a healthy exit would, because by this point
   * the headers are out and the status code is spent: silence and a hangup are
   * the same thing to a reader, and the whole shape of this protocol is that
   * they must not be.
   */
  function writeEndAndClose(
    res: ServerResponse,
    reason: FrameStreamEndReason,
  ): void {
    try {
      res.write(encodeFrameStreamRecord({ kind: FRAME_STREAM_KIND.end, reason }));
      res.end();
    } catch {
      // Already gone.
    }
  }

  /**
   * Headers, then a heartbeat immediately.
   *
   * The first record is not decoration: until one arrives, "the TCP connection
   * came up" and "the daemon authorized me and subscribed" look identical to a
   * reader, and on a static page they can stay identical for minutes.
   */
  function beginStream(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      // No content-length: this body has no length. `no-transform` matters as
      // much as `no-store` — an intermediary that "helpfully" buffers or
      // re-encodes turns a live stream into a download that arrives at the end.
      "cache-control": "no-store, no-transform",
      // nginx and friends buffer proxied responses by default.
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    // Nagle would hold a 24-byte heartbeat for up to 40ms waiting for company.
    res.socket?.setNoDelay(true);
    // The default socket timeout would kill a stream that is merely quiet.
    res.setTimeout(0);
    res.write(encodeFrameStreamRecord({ kind: FRAME_STREAM_KIND.heartbeat }));
  }

  /**
   * `?probe=1` — three heartbeats, a second apart, then a clean end.
   *
   * The one thing that cannot be proven from this repository is whether the
   * sandbox edge streams a chunked response or buffers it, and what it does to
   * an idle one. This lets that be answered on staging with `curl`: no browser,
   * no lease, no pane, no tab. (`computer-browser-stream.ts` carries the same
   * VALIDATE-ON-STAGING caveat for the same class of unknown.)
   */
  function runProbe(res: ServerResponse): void {
    let sent = 0;
    const entry = { end: (reason: FrameStreamEndReason) => finish(reason) };
    open.add(entry);
    let timer: unknown;
    const finish = (reason: FrameStreamEndReason | "probe_complete") => {
      timers.clearTimer(timer);
      if (!open.delete(entry)) return;
      res.write(
        encodeFrameStreamRecord({ kind: FRAME_STREAM_KIND.end, reason }),
      );
      res.end();
    };
    const beat = () => {
      if (sent >= PROBE_BEATS) {
        finish("probe_complete");
        return;
      }
      sent += 1;
      res.write(encodeFrameStreamRecord({ kind: FRAME_STREAM_KIND.heartbeat }));
      timer = timers.setTimer(beat, PROBE_INTERVAL_MS);
    };
    res.on("close", () => {
      timers.clearTimer(timer);
      open.delete(entry);
    });
    timer = timers.setTimer(beat, PROBE_INTERVAL_MS);
  }

  async function startSubscription(args: {
    res: ServerResponse;
    tabId: string | undefined;
    holder: string | undefined;
  }): Promise<void> {
    const { res, tabId, holder } = args;
    let ended = false;
    let stallTimer: unknown;
    let beatTimer: unknown;
    let unsubscribe: (() => void) | undefined;

    const entry = {
      end: (reason: FrameStreamEndReason) => end(reason),
    };

    /**
     * The single exit. Writes the reason in-band, because the status code was
     * spent when the headers went out: a reader can only tell "the lease moved"
     * from "the network dropped" by whether a final record arrived.
     */
    const end = (reason: FrameStreamEndReason): void => {
      if (ended) return;
      ended = true;
      timers.clearTimer(stallTimer);
      timers.clearTimer(beatTimer);
      unsubscribe?.();
      open.delete(entry);
      pacer.close();
      try {
        res.write(
          encodeFrameStreamRecord({ kind: FRAME_STREAM_KIND.end, reason }),
        );
        res.end();
      } catch {
        // Already gone. `res.on("close")` has done the bookkeeping.
      }
    };

    const pacer = createFramePacer({
      send: (data, cb) => {
        // Armed per write and cleared by the acknowledgement: a peer that stops
        // reading never acknowledges, and without this the in-flight slot — and
        // the screencast behind it — would stay busy for the daemon's lifetime.
        stallTimer = timers.setTimer(() => {
          if (ended) return;
          ended = true;
          timers.clearTimer(beatTimer);
          unsubscribe?.();
          open.delete(entry);
          // Closed HERE as well as in `end()`, because this path does not go
          // through it: setting `ended` makes the close handler return early,
          // so without this the pacer keeps its held frame and ships it into a
          // destroyed socket the moment the write callback fires — arming one
          // more stall timer on the way.
          pacer.close();
          // Destroy rather than end: a peer that is not reading will not read a
          // reason either, and a graceful close would wait on the same buffer.
          res.destroy();
        }, stallMs);
        res.write(data, (error) => {
          timers.clearTimer(stallTimer);
          cb(error ?? undefined);
        });
      },
    });

    // Registered BEFORE the await: a client that hangs up while we are still
    // resolving a viewport must still be cleaned up.
    open.add(entry);
    res.on("close", () => {
      if (ended) return;
      ended = true;
      timers.clearTimer(stallTimer);
      timers.clearTimer(beatTimer);
      unsubscribe?.();
      open.delete(entry);
      pacer.close();
    });

    const subscription = await handler.subscribeFrames({
      ...(tabId ? { tabId } : {}),
      ...(holder ? { holder } : {}),
      listener: (frame) => {
        pacer.push(
          encodeFrameStreamRecord({
            kind: FRAME_STREAM_KIND.frame,
            deviceWidth: frame.deviceWidth,
            deviceHeight: frame.deviceHeight,
            scale: frame.scale,
            ts: frame.ts,
            seq: frame.seq,
            // The viewport hands out base64; the wire carries the bytes.
            jpeg: new Uint8Array(Buffer.from(frame.data, "base64")),
          }),
        );
      },
      onRevoked: (reason) => {
        end(reason === "lease_parked" ? "lease_parked" : "lease_held");
      },
    });

    if (!subscription.ok) {
      end(subscription.error === "unknown_tab" ? "unknown_tab" : "lease_held");
      return;
    }
    if (ended) {
      // The client hung up while we were subscribing.
      subscription.unsubscribe();
      return;
    }
    unsubscribe = subscription.unsubscribe;

    const beat = () => {
      if (ended) return;
      // Order matters: prove liveness first, so a reader distinguishes a slow
      // check from a dead stream, then ask the two questions a one-way stream
      // cannot answer by itself.
      pacer.push(encodeFrameStreamRecord({ kind: FRAME_STREAM_KIND.heartbeat }));
      subscription.revalidate();
      if (ended) return; // revalidate may have revoked us
      void subscription.stillCurrent().then(
        (current) => {
          if (!current && !ended) end("tab_gone");
          else if (!ended) beatTimer = timers.setTimer(beat, heartbeatMs);
        },
        // A REJECTION IS NOT A NON-ANSWER YOU CAN IGNORE. `stillCurrent` asks
        // the driver for the tab's viewport, and that throws on ordinary
        // paths — a context that is closing answers "this browser is shutting
        // down" rather than a value. Left unhandled it did two things, and
        // the quieter one is worse: the tick never rescheduled, so the lease
        // stopped being re-asked for the life of the stream, which is exactly
        // the privacy hole the heartbeat exists to close on a page that does
        // not paint. And an unhandled rejection ends a Node process, so the
        // one that died was the daemon, taking every hosted session on the
        // box with it. Unable to prove the tab is still ours, we say so and
        // stop.
        () => {
          if (!ended) end("tab_gone");
        },
      );
    };
    beatTimer = timers.setTimer(beat, heartbeatMs);
  }

  function writeJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": payload === undefined ? 0 : Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  return {
    handle,
    closeAll(reason) {
      for (const entry of [...open]) entry.end(reason);
    },
    count: () => open.size,
  };
}
