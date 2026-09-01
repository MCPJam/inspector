/**
 * Rate-limit a frame stream to a floor interval, WITHOUT losing the last frame.
 *
 * Chromium's screencast paints as fast as the page does. Publishing all of it
 * would spend most of a local SSE connection on JPEGs of a spinner, so frames
 * are throttled here — but a plain "drop anything inside the window" throttle
 * is wrong for a COALESCED channel, and wrong in the way that matters most: the
 * final paint of a burst is exactly the one that shows what the page ended up
 * looking like. Drop it and the pane sits on a stale picture until the page
 * happens to paint again, which for a settled page is never.
 *
 * So this is leading-edge PLUS a mandatory trailing edge: the first frame goes
 * out immediately, frames inside the window replace one another in a one-slot
 * buffer, and whatever is left in that slot is emitted when the window closes.
 *
 * Pure and clock-injected so its timing is testable without a browser and
 * without real time.
 */

export interface FrameThrottleOptions<T> {
  /** Floor on the gap between emissions, in milliseconds. */
  minIntervalMs: number;
  /** Called with each frame that survives the throttle. */
  emit: (value: T) => void;
  /** Injected so tests drive time; defaults to the real clock and timers. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface FrameThrottle<T> {
  /** Offer a frame. It is emitted now, or held as the trailing frame. */
  push(value: T): void;
  /**
   * Raise the rate for a while, because a person is driving the page.
   *
   * Repeat calls extend the window rather than stacking, so a continuous
   * gesture holds the higher rate for as long as it lasts. Expiry is
   * arithmetic — a deadline compared on each push — so a boost costs no timer
   * of its own and cannot leave one behind.
   */
  boost(intervalMs: number, windowMs: number): void;
  /**
   * Drop anything pending and stop the timer.
   *
   * Called when the stream stops. Emitting the held frame on the way out would
   * repaint a pane that has just been told there is nothing to watch.
   */
  reset(): void;
}

export function createFrameThrottle<T>(
  options: FrameThrottleOptions<T>,
): FrameThrottle<T> {
  const now = options.now ?? Date.now;
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
  const clearTimer =
    options.clearTimer ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));

  let lastEmitAt = Number.NEGATIVE_INFINITY;
  let trailing: { value: T } | undefined;
  let timer: unknown;
  /** While `now() < boostUntil`, the floor is `boostIntervalMs`. */
  let boostUntil = Number.NEGATIVE_INFINITY;
  let boostIntervalMs = options.minIntervalMs;

  /** The floor in force RIGHT NOW. Read per push, never cached. */
  const interval = () =>
    now() < boostUntil ? boostIntervalMs : options.minIntervalMs;

  const flush = () => {
    timer = undefined;
    if (!trailing) return;
    const { value } = trailing;
    trailing = undefined;
    lastEmitAt = now();
    options.emit(value);
  };

  return {
    push(value: T): void {
      const elapsed = now() - lastEmitAt;
      const minIntervalMs = interval();
      if (elapsed >= minIntervalMs) {
        // Leading edge. Any frame held from a previous burst is superseded by
        // this newer one rather than emitted late and out of order.
        trailing = undefined;
        if (timer !== undefined) {
          clearTimer(timer);
          timer = undefined;
        }
        lastEmitAt = now();
        options.emit(value);
        return;
      }
      // Inside the window: keep only the newest. The timer is armed once per
      // window, not per frame — re-arming on every push would postpone the
      // trailing emission indefinitely under a continuous stream, which is the
      // failure this whole module exists to avoid.
      trailing = { value };
      if (timer === undefined) {
        timer = setTimer(flush, minIntervalMs - elapsed);
      }
    },

    boost(intervalMs: number, windowMs: number): void {
      boostIntervalMs = intervalMs;
      boostUntil = now() + windowMs;
      // RE-ARM a timer already waiting out the OLD, longer window. Without
      // this the frame that echoes the very input which triggered the boost
      // sits in the trailing slot for the rest of a 100ms wait — so the first
      // and most noticeable paint of a gesture is exactly the one the boost
      // fails to speed up.
      if (trailing === undefined || timer === undefined) return;
      const remaining = intervalMs - (now() - lastEmitAt);
      clearTimer(timer);
      timer = undefined;
      if (remaining <= 0) {
        flush();
        return;
      }
      timer = setTimer(flush, remaining);
    },

    reset(): void {
      trailing = undefined;
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
      lastEmitAt = Number.NEGATIVE_INFINITY;
      // The stream stopped; whoever was driving it is not driving it any more.
      boostUntil = Number.NEGATIVE_INFINITY;
      boostIntervalMs = options.minIntervalMs;
    },
  };
}
