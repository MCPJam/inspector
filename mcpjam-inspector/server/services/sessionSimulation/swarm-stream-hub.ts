import type { SwarmStreamEvent } from "../../../shared/swarm-stream-events.js";

const RING_BUFFER_SIZE = 200;

/**
 * How many sessions may hold a retained live frame at once. Frames are kept per
 * session so a late joiner sees a picture even for a session that already
 * finished, so this bounds the run's total retained bytes
 * (~48 KiB x this) rather than throwing away that behavior.
 */
const MAX_RETAINED_FRAME_SESSIONS = 64;

export type SwarmStreamListener = (event: SwarmStreamEvent) => void;

/**
 * Per-run multiplex hub: ring-buffers recent events for late SSE joiners and
 * fans out to live subscribers. One hub is owned by each active journey run
 * in {@link runningJourneyRuns}.
 *
 * Two retention policies, on purpose:
 *
 *   - Ordinary events go into a bounded ring buffer, replayed in order on
 *     late-join.
 *   - Live browser frames (`browser_frame`) go into a COALESCED sibling channel:
 *     one latest frame per session, never appended to the ring. An agent that
 *     clicks twenty times a turn would otherwise flush every lifecycle and trace
 *     event out of a 200-entry ring, so the run detail would show a live picture
 *     and lose the run. And a frame has no history worth replaying — the only
 *     interesting one is the current one.
 */
export class JourneyRunStreamHub {
  private readonly buffer: SwarmStreamEvent[] = [];
  /** Latest live frame per `chatSessionId`. Coalesced, not queued. */
  private readonly latestFrames = new Map<string, SwarmStreamEvent>();
  private readonly listeners = new Set<SwarmStreamListener>();

  emit(event: SwarmStreamEvent): void {
    if (event.type === "browser_frame") {
      if (event.chatSessionId) {
        // Delete-then-set so the Map's insertion order is true recency: `set`
        // on an existing key keeps its ORIGINAL position, which would make the
        // eviction below drop whichever session merely started first rather
        // than the one that has gone quietest.
        this.latestFrames.delete(event.chatSessionId);
        this.latestFrames.set(event.chatSessionId, event);
        // Retention is per SESSION and deliberately outlives each session's
        // completion — `subscribe` replays these first precisely so a joiner
        // arriving after a session ended still gets a picture. That means the
        // map grows with the run's session count, not its click count, so a
        // large fan-out (hosts x sessions-per-host) is the only way it gets
        // big: at 48 KiB a frame, a thousand sessions would be ~48 MB held for
        // the life of the run. Cap it and drop the least-recently-updated
        // session, which is the one whose picture is most likely already stale.
        while (this.latestFrames.size > MAX_RETAINED_FRAME_SESSIONS) {
          const oldest = this.latestFrames.keys().next();
          if (oldest.done) break;
          this.latestFrames.delete(oldest.value);
        }
      }
      this.fanout(event);
      return;
    }
    this.buffer.push(event);
    if (this.buffer.length > RING_BUFFER_SIZE) {
      this.buffer.splice(0, this.buffer.length - RING_BUFFER_SIZE);
    }
    this.fanout(event);
  }

  private fanout(event: SwarmStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Subscriber errors must not break the runner.
      }
    }
  }

  /**
   * Subscribe and immediately replay the current frame of each session, then the
   * ring buffer (late-join), then receive live events. Returns an unsubscribe
   * function.
   *
   * Frames come FIRST, deliberately. The SSE route closes the stream the moment
   * it sees a replayed `run_complete`, so anything delivered after the buffer is
   * dropped for a joiner arriving after the run ended — which is exactly when the
   * retained frame is the only picture available.
   */
  subscribe(listener: SwarmStreamListener): () => void {
    this.listeners.add(listener);
    for (const frame of this.latestFrames.values()) {
      try {
        listener(frame);
      } catch {
        // ignore
      }
    }
    for (const event of this.buffer) {
      try {
        listener(event);
      } catch {
        // ignore
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot of the current ring buffer (tests / diagnostics). */
  getBuffer(): readonly SwarmStreamEvent[] {
    return this.buffer;
  }

  /** Snapshot of the current per-session live frames (tests / diagnostics). */
  getLatestFrames(): ReadonlyMap<string, SwarmStreamEvent> {
    return this.latestFrames;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
