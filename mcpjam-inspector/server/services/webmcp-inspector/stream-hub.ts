/**
 * Per-session event fan-out with bounded replay.
 *
 * Modelled on `sessionSimulation/swarm-stream-hub.ts`, including its coalesced
 * frame channel. Three retention policies, one per kind of thing:
 *
 *   - Activity goes into a bounded ring, replayed in order to a late joiner.
 *   - Tool events are full snapshots, so only the latest is retained; keeping
 *     200 copies of a page-authored schema is both redundant and an avoidable
 *     memory multiplier.
 *   - Viewport frames go into a single COALESCED slot and never touch the ring.
 *     A page animating at 10fps would otherwise flush every tool registration
 *     and invocation out of a 200-entry ring within twenty seconds, so the
 *     timeline — the thing the session exists to produce — would be destroyed
 *     by the picture beside it. One slot rather than a map because a WebMCP
 *     session inspects exactly one page: there is nothing to key or evict.
 *
 * Replay therefore hands a reconnecting client exactly one frame: the current
 * one. That is the whole repaint story — no gap reasoning, no catch-up.
 */
import {
  WEBMCP_ACTIVITY_RING_SIZE,
  type WebMcpEvent,
} from "@/shared/webmcp-inspector-protocol";

export type WebMcpEventListener = (event: WebMcpEvent) => void;

export class WebMcpStreamHub {
  private readonly ring: WebMcpEvent[] = [];
  private latestTools: Extract<WebMcpEvent, { type: "tools" }> | undefined;
  /** The current paint. Replaced, never queued — see the class comment. */
  private latestFrame: Extract<WebMcpEvent, { type: "frame" }> | undefined;
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
    } else if (event.type === "frame") {
      this.latestFrame = event;
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
      if (this.latestFrame) replayEvents.push(this.latestFrame);
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
    if (this.latestFrame) events.push(this.latestFrame);
    return events.sort((a, b) => a.seq - b.seq);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }
}
