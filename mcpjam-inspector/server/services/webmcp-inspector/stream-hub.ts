/**
 * Per-session event fan-out with bounded replay.
 *
 * Modelled on `sessionSimulation/swarm-stream-hub.ts`, minus its coalesced
 * frame channel: V1 streams no video. Tool events are full snapshots, so only
 * the latest one is retained; keeping 200 copies of a page-authored schema is
 * both redundant and an avoidable memory multiplier.
 */
import {
  WEBMCP_ACTIVITY_RING_SIZE,
  type WebMcpEvent,
} from "@/shared/webmcp-inspector-protocol";

export type WebMcpEventListener = (event: WebMcpEvent) => void;

export class WebMcpStreamHub {
  private readonly ring: WebMcpEvent[] = [];
  private latestTools: Extract<WebMcpEvent, { type: "tools" }> | undefined;
  private readonly listeners = new Set<WebMcpEventListener>();
  private closed = false;

  constructor(private readonly ringSize: number = WEBMCP_ACTIVITY_RING_SIZE) {}

  get listenerCount(): number {
    return this.listeners.size;
  }

  publish(event: WebMcpEvent): void {
    if (this.closed) return;
    if (event.type === "tools") {
      this.latestTools = event;
    } else {
      this.ring.push(event);
      if (this.ring.length > this.ringSize) {
        this.ring.splice(0, this.ring.length - this.ringSize);
      }
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
      const replayEvents = this.ring.slice(-replay);
      if (this.latestTools) replayEvents.push(this.latestTools);
      replayEvents.sort((a, b) => a.seq - b.seq);
      for (const event of replayEvents) {
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
    const events = [...this.ring];
    if (this.latestTools) events.push(this.latestTools);
    return events.sort((a, b) => a.seq - b.seq);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}
