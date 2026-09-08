/**
 * A per-key serialization lock.
 *
 * The hosted-browser debug probe uses a fixed port + a single persistent Chrome
 * profile per computer, and browserd clears the profile's singleton lock on
 * boot — so two probes targeting the SAME durable computer must not run at once
 * or they collide on the port/profile and disrupt each other. Callers key by
 * (user, project); work for one key runs strictly in sequence, while different
 * keys run concurrently. A failed run never blocks the next (the chain advances
 * on settle either way), and the map entry is dropped once its key drains.
 */
const chains = new Map<string, Promise<unknown>>();

export async function withKeyedLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve();
  // Run after the prior settles whether it resolved or rejected.
  const next = prior.then(fn, fn);
  const tail = next.then(
    () => {},
    () => {},
  );
  chains.set(key, tail);
  try {
    return await next;
  } finally {
    // Drop the entry only if we are still the tail, so a queued follow-up that
    // already chained onto us is preserved.
    if (chains.get(key) === tail) chains.delete(key);
  }
}

/** Test-only: how many keys currently have a chain (0 when fully drained). */
export function activeKeyedLockCount(): number {
  return chains.size;
}
