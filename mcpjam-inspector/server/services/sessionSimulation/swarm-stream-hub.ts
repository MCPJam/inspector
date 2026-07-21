import type { SwarmStreamEvent } from "../../../shared/swarm-stream-events.js";

const RING_BUFFER_SIZE = 200;

export type SwarmStreamListener = (event: SwarmStreamEvent) => void;

/**
 * Per-run multiplex hub: ring-buffers recent events for late SSE joiners and
 * fans out to live subscribers. One hub is owned by each active journey run
 * in {@link runningJourneyRuns}.
 */
export class JourneyRunStreamHub {
  private readonly buffer: SwarmStreamEvent[] = [];
  private readonly listeners = new Set<SwarmStreamListener>();

  emit(event: SwarmStreamEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > RING_BUFFER_SIZE) {
      this.buffer.splice(0, this.buffer.length - RING_BUFFER_SIZE);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Subscriber errors must not break the runner.
      }
    }
  }

  /**
   * Subscribe and immediately replay the ring buffer (late-join), then receive
   * live events. Returns an unsubscribe function.
   */
  subscribe(listener: SwarmStreamListener): () => void {
    this.listeners.add(listener);
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

  get listenerCount(): number {
    return this.listeners.size;
  }
}
