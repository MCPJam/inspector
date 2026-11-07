/**
 * The executor's doorbell, split out of `executor.ts` so the routes that ring
 * it (`/api/internal/events/enqueue` and `/dispatch`) do not import the whole
 * turn engine just to wake a loop.
 *
 * An unconfigured replica has no executor bell registered. A ring there is
 * a no-op; a configured replica claims the work on its next poll.
 */

let bell: (() => void) | undefined;

/** Register the running executor's wake-up; returns an unregister. */
export function registerEventsExecutorBell(ring: () => void): () => void {
  bell = ring;
  return () => {
    if (bell === ring) bell = undefined;
  };
}

/** Wake the running executor, if this replica runs one. */
export function kickEventsExecutor(): void {
  bell?.();
}
