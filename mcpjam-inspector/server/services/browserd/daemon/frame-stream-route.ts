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
  type FrameStreamStats,
} from "../frame-stream";
import { createFramePacer } from "../../webmcp-inspector/frame-pacer";
import type { BrowserdRequestHandler, DaemonRequest } from "./request-handler";
import type { VideoEncoder } from "./video-encoder";
import { BROWSERD_OBSERVATION_VIEWPORT } from "../protocol";

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
   * The display encoder, when this box has one.
   *
   * Absent means `?codec=h264` answers `video_unavailable` — which is a
   * SUPPORTED state, not a failure: the watcher falls back to the JPEG
   * screencast, exactly as a client without `VideoDecoder` does.
   */
  video?: VideoEncoder;
  /** The captured display's size, for the video records' geometry. */
  displaySize?: { width: number; height: number };
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
  handler: Pick<
    BrowserdRequestHandler,
    "authorize" | "subscribeFrames" | "watchLease" | "tabsSnapshot"
  >,
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

    // VIDEO IS THE ACTIVE TAB, so `tabId` is ignored for it. The encoder grabs
    // the X display, which has no concept of a tab — per-tab watching stays
    // JPEG, and the pane draws its own tab strip because kiosk hides
    // Chromium's.
    if (query?.get("codec") === "h264") {
      void startVideoSubscription({ res, holder }).catch(() => {
        writeEndAndClose(res, "video_unavailable");
      });
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
   * The video path.
   *
   * Structurally the JPEG one with two swaps: the pixels come from the shared
   * display encoder instead of this subscriber's own viewport, and the lease
   * question is asked through `watchLease` rather than by subscribing to a tab
   * — subscribing would start a screencast and a JPEG encoder nobody reads,
   * purely to borrow the check.
   *
   * One encoder, a gate PER subscriber. A person taking the browser ends every
   * other watcher's stream with its own `lease_held` while the encoder keeps
   * running for the holder's own pane: an end reason is about who may look, not
   * about who is encoding.
   */
  async function startVideoSubscription(args: {
    res: ServerResponse;
    holder: string | undefined;
  }): Promise<void> {
    const { res, holder } = args;
    const encoder = options.video;
    if (!encoder) {
      // No encoder on this box: no ffmpeg on the image, or the operator turned
      // it off. The watcher falls back to JPEG.
      writeEndAndClose(res, "video_unavailable");
      return;
    }

    let ended = false;
    let stallTimer: unknown;
    let beatTimer: unknown;
    let unsubscribe: (() => void) | undefined;
    let release: (() => void) | undefined;
    let seq = 0;
    const size = options.displaySize ?? {
      width: BROWSERD_OBSERVATION_VIEWPORT.width,
      height: BROWSERD_OBSERVATION_VIEWPORT.height,
    };
    // Capture pixels per CSS pixel, so a click maps through exactly as it does
    // for a JPEG. The pane never has to know which codec drew the picture.
    const scale = size.width / BROWSERD_OBSERVATION_VIEWPORT.width;

    const entry = { end: (reason: FrameStreamEndReason) => end(reason) };
    const end = (reason: FrameStreamEndReason): void => {
      if (ended) return;
      ended = true;
      timers.clearTimer(stallTimer);
      timers.clearTimer(beatTimer);
      unsubscribe?.();
      release?.();
      open.delete(entry);
      pacer.close();
      try {
        res.write(
          encodeFrameStreamRecord({ kind: FRAME_STREAM_KIND.end, reason }),
        );
        res.end();
      } catch {
        // Already gone.
      }
    };

    const pacer = createFramePacer({
      send: (data, cb) => {
        stallTimer = timers.setTimer(() => {
          if (ended) return;
          ended = true;
          timers.clearTimer(beatTimer);
          unsubscribe?.();
          release?.();
          open.delete(entry);
          pacer.close();
          res.destroy();
        }, stallMs);
        res.write(data, (error) => {
          timers.clearTimer(stallTimer);
          cb(error ?? undefined);
        });
      },
    });

    open.add(entry);
    res.on("close", () => {
      if (ended) return;
      ended = true;
      timers.clearTimer(stallTimer);
      timers.clearTimer(beatTimer);
      unsubscribe?.();
      release?.();
      open.delete(entry);
      pacer.close();
    });

    const gate = handler.watchLease({
      ...(holder ? { holder } : {}),
      onRevoked: (reason) =>
        end(reason === "lease_parked" ? "lease_parked" : "lease_held"),
    });
    if (!gate.ok) {
      end(gate.error === "lease_parked" ? "lease_parked" : "lease_held");
      return;
    }
    if (ended) {
      gate.release();
      return;
    }
    release = gate.release;

    unsubscribe = encoder.subscribe((unit) => {
      pacer.push(
        encodeFrameStreamRecord({
          kind: unit.key
            ? FRAME_STREAM_KIND.video_key
            : FRAME_STREAM_KIND.video_delta,
          deviceWidth: size.width,
          deviceHeight: size.height,
          scale,
          ts: Date.now(),
          seq: (seq += 1),
          au: unit.bytes,
        }),
      );
    });

    // Checked AFTER subscribing: a spawn that fails does so synchronously
    // inside `subscribe`, and asking first would race the answer.
    const failure = encoder.failure();
    if (failure) {
      end("video_unavailable");
      return;
    }

    const beat = (): void => {
      if (ended) return;
      const tabs = handler.tabsSnapshot?.();
      pacer.push(
        encodeFrameStreamRecord({
          kind: FRAME_STREAM_KIND.heartbeat,
          stats: {
            subscribers: encoder.subscriberCount(),
            // What a person is actually looking at. The video stream grabs the
            // X display, so a model `activate_tab` changes the picture out from
            // under them — and kiosk hides Chromium's own tab strip, so nothing
            // else here would say so.
            ...(tabs ? { tabs } : {}),
            // `mpdecimate` means an idle page produces NO frames at all, so
            // silence here is a quiet page rather than a stall. Saying which
            // is what stops an adaptive client stepping the quality down on a
            // page that is simply not moving.
            encoderIdle: encoder.takeIdle(),
          },
        }),
      );
      gate.revalidate();
      if (ended) return;
      // An encoder that died mid-stream is a stream that will never paint
      // again. Said in-band, so the watcher falls back rather than waiting.
      if (encoder.failure()) {
        end("video_unavailable");
        return;
      }
      beatTimer = timers.setTimer(beat, heartbeatMs);
    };
    beatTimer = timers.setTimer(beat, heartbeatMs);
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
    /**
     * The subscription, declared before the pacer that reports drops to it.
     *
     * The pacer is built first because `subscribeFrames` needs somewhere to
     * push, so the drop callback closes over this rather than over a value:
     * a drop before the subscription resolves has no viewport to attribute
     * itself to, and is skipped rather than guessed at.
     */
    let subscription:
      | Awaited<ReturnType<typeof handler.subscribeFrames>>
      | undefined;

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

    const pacer = createFramePacer(
      {
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
      },
      // The pacer's overwrite is the third silent drop path (the viewport owns
      // the other two). Counting it HERE, on the viewport that produced the
      // frame, is what makes one number describe the whole way out of the box.
      () => subscription?.ok && subscription.noteTransportDrop(),
    );

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

    subscription = await handler.subscribeFrames({
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
    // Narrowed once, so the tick below reads a value TypeScript can see is
    // subscribed rather than re-narrowing a mutable binding on every beat.
    const live = subscription;
    /**
     * `framesIn` at the previous beat.
     *
     * How "the encoder has nothing to send" is told from "the stream broke".
     * Undefined on the first beat, where there is no previous count to compare
     * against and claiming either answer would be a guess.
     */
    let lastFramesIn: number | undefined;

    const beat = () => {
      if (ended) return;
      // Order matters: prove liveness first, so a reader distinguishes a slow
      // check from a dead stream, then ask the two questions a one-way stream
      // cannot answer by itself.
      pacer.push(
        encodeFrameStreamRecord({
          kind: FRAME_STREAM_KIND.heartbeat,
          // Additive by construction: a v1 reader slices this payload by its
          // length and discards it, so an old inspector against a new daemon
          // sees exactly the heartbeat it always did.
          stats: (() => {
            const stats = statsFor(live, lastFramesIn);
            lastFramesIn = stats.framesIn;
            const tabs = handler.tabsSnapshot?.();
            return tabs ? { ...stats, tabs } : stats;
          })(),
        }),
      );
      live.revalidate();
      if (ended) return; // revalidate may have revoked us
      void live.stillCurrent().then(
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

/**
 * The daemon's own numbers, as the heartbeat carries them.
 *
 * `encoderIdle` is derived rather than reported: this transport's encoder is
 * Chromium's screencast, and "nothing came in since the last beat" is exactly
 * what a quiet page looks like. Saying so is what stops an adaptive client
 * reading silence as loss and stepping the quality down on a page that is
 * simply not moving.
 */
function statsFor(
  subscription: {
    counters: () => {
      framesIn: number;
      framesOut: number;
      bytesOut: number;
      dropped: { dedupe: number; oversize: number; pacer: number };
    };
    subscriberCount: () => number;
  },
  /** `framesIn` at the previous beat, or undefined on the first one. */
  previousFramesIn: number | undefined,
): FrameStreamStats {
  const counters = subscription.counters();
  return {
    framesIn: counters.framesIn,
    framesOut: counters.framesOut,
    bytesOut: counters.bytesOut,
    dropped: counters.dropped,
    subscribers: subscription.subscriberCount(),
    ...(previousFramesIn === undefined
      ? {}
      : { encoderIdle: counters.framesIn === previousFramesIn }),
  };
}
