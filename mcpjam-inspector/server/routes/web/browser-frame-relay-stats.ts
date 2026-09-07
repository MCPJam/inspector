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
 * BACKPRESSURE IS A DROP, NOT A QUEUE. A socket that cannot take a frame is
 * not helped by being handed the next one as well: a pane behind a congested
 * link would walk an ever-older page. One frame is held, newest wins, and the
 * overwrite is counted — the same rule as `webmcp-inspector/frame-pacer.ts`,
 * which cannot be reused here because a Hono `WSContext` reports no send
 * completion to pace against, only `bufferedAmount`.
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
  dropped?: { dedupe?: number; oversize?: number; pacer?: number };
  subscribers?: number;
  /** The encoder has nothing to send, so silence is not loss. */
  encoderIdle?: boolean;
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
   * about to do with it. The bytes are counted as INPUT either way: a frame
   * the relay received and could not forward is exactly the loss this exists
   * to make visible.
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
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

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
