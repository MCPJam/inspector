/**
 * Per-session event fan-out with bounded replay.
 *
 * Modelled on `sessionSimulation/swarm-stream-hub.ts`, minus its coalesced
 * frame channel: V1 streams no video, so every event is worth keeping in order.
 * A ring buffer means a client that connects late, reloads, or drops its
 * connection gets the recent history rather than an empty timeline.
 */
import {
  WEBMCP_ACTIVITY_RING_SIZE,
  type WebMcpEvent,
} from "@/shared/webmcp-inspector-protocol";

export type WebMcpEventListener = (event: WebMcpEvent) => void;

export class WebMcpStreamHub {
  private readonly ring: WebMcpEvent[] = [];
  private readonly listeners = new Set<WebMcpEventListener>();
  private closed = false;

  constructor(private readonly ringSize: number = WEBMCP_ACTIVITY_RING_SIZE) {}

  get listenerCount(): number {
    return this.listeners.size;
  }

  publish(event: WebMcpEvent): void {
    if (this.closed) return;
    this.ring.push(event);
    if (this.ring.length > this.ringSize) {
      this.ring.splice(0, this.ring.length - this.ringSize);
    }
    for (const listener of this.listeners) {
      // A throwing subscriber must not take down the publisher, which is the
      // session runtime reacting to a browser event.
      try {
        listener(event);
      } catch {
        /* ignore */
      }
    }
  }

  /** Replay up to `replay` buffered events, then stream live ones. */
  subscribe(listener: WebMcpEventListener, replay = this.ringSize): () => void {
    if (replay > 0) {
      for (const event of this.ring.slice(-replay)) {
        try {
          listener(event);
        } catch {
          /* ignore */
        }
      }
    }
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  buffered(): readonly WebMcpEvent[] {
    return this.ring;
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}
