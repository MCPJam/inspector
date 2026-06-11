/**
 * Per-server serialization for tunnel lifecycle operations (create, rotate,
 * close). Provisioning spans several non-atomic steps — backend token mint
 * (which revokes the previous credential), ngrok listen, state recording —
 * so two overlapping requests for the same server could otherwise leave the
 * live listener enforcing one secret while persistence holds another.
 *
 * Callers must re-check current state (e.g. "does a listener already
 * exist?") inside the locked section: the second of two racing creates
 * should observe the first one's listener and return it, not re-provision.
 */

const locks = new Map<string, Promise<unknown>>();

export function withTunnelLock<T>(
  serverId: string,
  fn: () => Promise<T>
): Promise<T> {
  const prev = locks.get(serverId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  // Chain survives fn rejections; drop the entry once we're the tail.
  const tail = run.catch(() => {});
  locks.set(serverId, tail);
  void tail.finally(() => {
    if (locks.get(serverId) === tail) {
      locks.delete(serverId);
    }
  });
  return run;
}
