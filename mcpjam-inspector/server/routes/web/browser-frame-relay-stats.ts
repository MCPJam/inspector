/**
 * What a frame relay can see, counted — for both browser panes.
 *
 * Before this, a frame that never reached a pane left no trace anywhere: the
 * daemon had encoded it, the relay had received it, and the pane simply never
 * painted. "Feels laggy" was the only report available, and every change to the
 * pipeline — the throttle floor, the transport, the batching — was argued from
 * impressions. Counting is the whole point: `framesIn` against `framesOut` is
 * the relay's own loss, and it is the number every later step in the viewport
 * wave has to beat.
 *
 * WHY A MODULE AND NOT TWO COPIES. The hosted relay reads a daemon's byte
 * stream over HTTP and the local one calls `subscribeFrames` in process; what
 * they do with a frame after that — count it, stamp it, decide whether the
 * socket can take it — is identical, and a second copy of the drop accounting
 * would drift within a release. The daemon's own counters arrive separately
 * (they cross the sandbox boundary in the heartbeat) and are MERGED into the
 * same message here, so a pane reads one `stats` shape whichever engine it is
 * looking at.
 *
 * BACKPRESSURE IS A DROP, NOT A QUEUE — and here it is a drop with NO held
 * slot, unlike `webmcp-inspector/frame-pacer.ts`. That pacer can hold one
 * frame because a callback tells it when the socket drained; a Hono
 * `WSContext` reports no send completion at all, only `bufferedAmount`, so a
 * held frame would have nothing to wake it and the pane would freeze with the
 * stream healthy. Dropping the current frame instead converges the pane on the
 * live picture: the next one is already on its way, and it is the one worth
 * showing. Every drop is counted.
 */

/** How often the relay tells the pane what it has seen. */
const DEFAULT_STATS_INTERVAL_MS = 1_000;

/**
 * How much may sit unsent before a frame is held rather than queued.
 *
 * Roughly two 256 KiB frames: enough that an ordinary paint burst rides
 * through untouched, small enough that a pane behind a slow link converges on
 * the current picture instead of replaying the last ten seconds of one.
 */
const DEFAULT_MAX_BUFFERED_BYTES = 512 * 1024;

/** Drop counters the daemon reports about itself (V-4a). */
export interface DaemonFrameCounters {
  framesIn?: number;
  framesOut?: number;
  bytesOut?: number;
  dropped?: { dedupe?: number; oversize?: number; pacer?: number };
  subscribers?: number;
  /** The encoder has nothing to send, so silence is not loss. */
  encoderIdle?: boolean;
  /**
   * What is open on the box, and which one is on screen.
   *
   * Carried HERE and not only on the frame wire, because the hosted relay
   * consumes the daemon's heartbeat itself: it reads the stats off it and
   * emits its own `stats` message, so the pane's frame-wire `onHeartbeat`
   * never fires on that engine at all. Without this the tab strip — a
   * hosted-only feature — never updated once.
   */
  tabs?: { active?: string; list?: Array<{ id: string; url: string }> };
}

export interface FrameRelayStatsSnapshot {
  framesIn: number;
  framesOut: number;
  bytes: number;
  dropped: number;
  subscribers: number;
  daemon?: DaemonFrameCounters;
}

export interface FrameRelayStats {
  /**
   * Offer a frame to the socket.
   *
   * Returns false when it was dropped, so the caller can skip whatever it was
   * about to do with it. The FRAME is counted either way — one the relay
   * received and could not forward is exactly the loss this exists to make
   * visible — while `bytes` counts only what was actually written, because it
   * sits beside `framesOut` and the pane's kbps figure is about what reached
   * it rather than about what it missed.
   */
  offer(bytes: number, write: () => void): boolean;
  /** A drop the caller detected itself (a closed socket, a failed send). */
  countDrop(n?: number): void;
  setSubscribers(count: number): void;
  /** Fold in what the daemon says about its own side of the stream. */
  mergeDaemon(counters: DaemonFrameCounters): void;
  /** Begin the periodic `stats` message. */
  start(): void;
  stop(): void;
  snapshot(): FrameRelayStatsSnapshot;
}

export interface FrameRelayStatsOptions {
  /** Ship one JSON control message to the pane. */
  send(payload: string): void;
  /** How much the socket still owes the network, when the runtime says. */
  bufferedAmount?: () => number | undefined;
  intervalMs?: number;
  maxBufferedBytes?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createFrameRelayStats(
  options: FrameRelayStatsOptions,
): FrameRelayStats {
  const intervalMs = options.intervalMs ?? DEFAULT_STATS_INTERVAL_MS;
  const maxBuffered = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) =>
      clearInterval(handle as ReturnType<typeof setInterval>));

  let framesIn = 0;
  let framesOut = 0;
  let bytes = 0;
  let dropped = 0;
  let subscribers = 0;
  let daemon: DaemonFrameCounters | undefined;
  let timer: unknown;
  let stopped = false;

  const congested = (): boolean => {
    const buffered = options.bufferedAmount?.();
    return typeof buffered === "number" && buffered > maxBuffered;
  };

  return {
    offer(frameBytes, write) {
      framesIn += 1;
      if (congested()) {
        // Held is not queued: there is no held slot here at all, because the
        // NEXT frame is the one worth showing and it is already on its way.
        // Dropping the current one converges the pane on the live picture.
        dropped += 1;
        return false;
      }
      try {
        write();
      } catch {
        // The socket went away between the check and the send.
        dropped += 1;
        return false;
      }
      framesOut += 1;
      bytes += Math.max(0, Math.round(frameBytes));
      return true;
    },
    countDrop(n = 1) {
      dropped += Math.max(0, Math.round(n));
    },
    setSubscribers(count) {
      subscribers = Math.max(0, Math.round(count));
    },
    mergeDaemon(counters) {
      daemon = counters;
    },
    start() {
      if (timer !== undefined || stopped) return;
      timer = setTimer(() => {
        // SENT WHILE CONGESTED TOO, unlike the frames themselves.
        //
        // This is the one message that ENDS congestion. `dropped` is what the
        // pane's adaptive tier reads to step down, and the tab list is what
        // its strip redraws from; withholding both exactly while frames are
        // being dropped is a control loop with its feedback wire cut — the
        // pane keeps asking for a quality the socket cannot carry, so the
        // congestion that suppressed the telemetry is what the telemetry
        // would have fixed. A few hundred bytes on a timer is not what put a
        // socket over its high-water mark; the frames it is reporting on are,
        // and those are still dropped.
        try {
          options.send(
            JSON.stringify({
              type: "stats",
              framesIn,
              framesOut,
              bytes,
              dropped,
              subscribers,
              ...(daemon ? { daemon } : {}),
            }),
          );
        } catch {
          // A socket that has gone away; the close path does the bookkeeping.
        }
      }, intervalMs);
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
    snapshot: () => ({
      framesIn,
      framesOut,
      bytes,
      dropped,
      subscribers,
      ...(daemon ? { daemon } : {}),
    }),
  };
}

/**
 * The pane's round trip, measured on the pane's own clock.
 *
 * The pane stamps `t` and this hands the same number back; nothing here reads
 * it, because the relay's clock and the pane's are different machines on the
 * hosted path and subtracting one from the other produces a number that looks
 * like latency and is not. Today's ping/pong carries nothing at all, so a pane
 * could tell "the socket is up" and nothing else.
 */
export function pongFor(message: { type?: unknown; t?: unknown }): string {
  return JSON.stringify({
    type: "pong",
    ...(typeof message.t === "number" && Number.isFinite(message.t)
      ? { t: message.t }
      : {}),
  });
}
