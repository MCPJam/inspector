/**
 * The current paint of one session, delivered to whoever is watching it.
 *
 * Frames used to ride {@link WebMcpStreamHub} beside the timeline, in a
 * coalesced slot the hub kept apart from its activity ring precisely so a page
 * animating at 10fps could not flush the record the session exists to produce.
 * That worked, but it put pixels on the channel that carries tools, activity
 * and status — so every consumer of that channel had to filter them out, the
 * SSE route grew a `frames=off` switch and a backpressure branch for payloads
 * it did not want, and the one transport that DOES want pixels reached them
 * through a JSON envelope it immediately re-encoded to bytes.
 *
 * So frames get their own channel. The hub goes back to being events; this is
 * one slot, one kind of thing, and the only subscriber is the frame socket.
 *
 * ONE SLOT, NOT A QUEUE, for the same reason the hub's was: the only
 * interesting frame is the current one. A watcher that arrives mid-session is
 * handed it immediately, which is the whole repaint story — no gap reasoning,
 * no catch-up.
 */
import type { WebMcpFrame } from "@/shared/webmcp-inspector-protocol";

/**
 * A frame, with the session's own event counter stamped on it.
 *
 * The counter is shared with the hub's events rather than private to the
 * stream: the client compares it against the sequence it last painted, and two
 * independent counters would make "is this newer than what I am showing?"
 * unanswerable across a transport change.
 */
export type RuntimeFrame = WebMcpFrame & { seq: number };

export type RuntimeFrameListener = (frame: RuntimeFrame) => void;

export class WebMcpFrameChannel {
  /** The current paint. Replaced, never queued — see the module comment. */
  private current: RuntimeFrame | undefined;
  private readonly listeners = new Set<RuntimeFrameListener>();
  private closed = false;

  get listenerCount(): number {
    return this.listeners.size;
  }

  publish(frame: RuntimeFrame): void {
    if (this.closed) return;
    this.current = frame;
    for (const listener of this.listeners) {
      // A throwing subscriber must not take down the publisher, which is the
      // session runtime reacting to a paint.
      try {
        listener(frame);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Watch, and receive the current paint at once if there is one.
   *
   * Delivered synchronously on subscribe rather than waiting for the next
   * paint: a settled page sends no other, so a socket that opened onto one
   * would sit on "Waiting for the first frame…" until somebody touched it.
   */
  subscribe(listener: RuntimeFrameListener): () => void {
    if (this.current) {
      try {
        listener(this.current);
      } catch {
        /* ignore */
      }
    }
    if (this.closed) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  latest(): RuntimeFrame | undefined {
    return this.current;
  }

  /**
   * Forget the retained paint.
   *
   * Called when the stream stops and when the page navigates away: a frame of
   * a page that has been left — or of a stream nobody is running any more — is
   * not "the current one", and handing it to the next watcher would show them
   * a page that is gone. Nothing is published; a connected client already knows,
   * and this only governs what a LATE ARRIVAL is handed.
   */
  clear(): void {
    this.current = undefined;
  }

  close(): void {
    this.closed = true;
    this.current = undefined;
    this.listeners.clear();
  }
}
