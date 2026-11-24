/**
 * A `server-canvas` rollout answer bounded in time, for callers that hold a
 * connect or a connection while they wait for it: the connect hook before it
 * captures, and the background probes before and after they run.
 */

/** `rollout`'s answer, or off when it has not come within `waitMs` or failed. */
export async function rolloutWithin(
  rollout: Promise<boolean>,
  waitMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs);
  });
  try {
    // A rollout that fails is off, as `resolveServerCanvasRollout` reads it.
    return await Promise.race([rollout.catch(() => false), late]);
  } finally {
    clearTimeout(timer);
  }
}
