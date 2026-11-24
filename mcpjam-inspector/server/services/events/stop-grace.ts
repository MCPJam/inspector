/**
 * How long a stopping events worker waits for its in-flight keeper step or
 * trigger run. Server shutdown force-exits 5s after it starts and still has
 * teardowns to finish (journey runs, tunnels, browsers, the analytics flush).
 * Abandoning the work is safe: its lease lapses and the next claim, on this
 * replica or another, picks it up.
 */
export const EVENTS_STOP_GRACE_MS = 1_000;

/** Resolves when `work` settles or `ms` passes, whichever is first. Never rejects. */
export async function settleWithin(
  work: Promise<unknown>,
  ms: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
}
