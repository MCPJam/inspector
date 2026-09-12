/**
 * The current frame, on a subscription of its own.
 *
 * WHY NOT A STORE. A frame arrives up to thirty times a second, and it is
 * interesting to exactly one component: the pane that draws it. Published into
 * a product store, every one of those arrivals is a state update that the
 * store's other subscribers — a tool list, an activity timeline, a chat panel —
 * must each be memoised against, and the cost of forgetting is invisible: the
 * picture still works, the side panels just re-render sixty times while
 * somebody scrolls. That was measured as thirty activity-panel renders for
 * thirty frames before it was fixed with selectors, which is a fix that has to
 * be re-applied every time a new panel subscribes.
 *
 * So frames do not go in a store at all. One slot, one notification list, and
 * the only subscriber is the pane.
 *
 * OWNERSHIP: this holds a REFERENCE, never a resource. The `ImageBitmap` inside
 * a `PaneFrame` belongs to the connection that decoded it, which closes the one
 * it replaces and the last one on teardown. Publishing `null` here says "there
 * is nothing to draw"; it does not free anything, and this must never call
 * `close()` — a channel that disposed of what it merely points at would race
 * the connection that owns it.
 */
import { useSyncExternalStore } from "react";
import type { PaneFrame } from "./input";

export interface FrameChannel {
  /** Offer the newest picture, or `null` when there is nothing to draw. */
  publish(frame: PaneFrame | null): void;
  /**
   * The current picture.
   *
   * STABLE BETWEEN PUBLISHES, which is a `useSyncExternalStore` requirement
   * rather than an optimisation: a getter that built a new object per call
   * would make React see a change on every render and loop forever.
   */
  latest(): PaneFrame | null;
  subscribe(listener: () => void): () => void;
}

export function createFrameChannel(): FrameChannel {
  let current: PaneFrame | null = null;
  const listeners = new Set<() => void>();
  return {
    publish(frame) {
      if (current === frame) return;
      current = frame;
      for (const listener of listeners) {
        // One throwing subscriber must not stop the others being told, and
        // must not propagate into the socket's message handler.
        try {
          listener();
        } catch {
          /* ignore */
        }
      }
    },
    latest: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Render the channel's current frame.
 *
 * The server snapshot is the same getter: these panes never render on a server,
 * and handing `useSyncExternalStore` a second source would be a second answer
 * to "what is on screen".
 */
export function useFrameChannel(channel: FrameChannel): PaneFrame | null {
  return useSyncExternalStore(
    channel.subscribe,
    channel.latest,
    channel.latest,
  );
}
