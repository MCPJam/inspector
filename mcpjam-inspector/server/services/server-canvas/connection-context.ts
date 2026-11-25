/**
 * A cache of the last capture context hash seen live for each hosted project
 * server and actor on this Inspector instance. Observed traffic never depends
 * on it: the observers compute the hash from the connection that produced the
 * traffic (`observation-context.ts`). Only the browser's Apps bridge batches,
 * which arrive without a connection, read it, and a miss records nothing.
 *
 * The actor is the user the backend authorized for the request (the Convex
 * user id it reports), so one member's bridge batch is never filed under
 * another member's context: contexts differ by the account each one connects
 * with. Filled by the hosted observer whenever it computes a live hash. In
 * memory and bounded.
 */

/** Oldest entries are dropped past this many project server and actor pairs. */
export const MAX_CACHED_CONTEXTS = 1024;

export interface HostedContextKey {
  projectId: string;
  serverId: string;
  /** The authorized actor's Convex user id. */
  actorId: string;
}

const hashes = new Map<string, string>();

function cacheKey({ projectId, serverId, actorId }: HostedContextKey): string {
  return JSON.stringify([projectId, serverId, actorId]);
}

export function rememberHostedContext(
  key: HostedContextKey,
  contextHash: string,
): void {
  const entry = cacheKey(key);
  hashes.delete(entry);
  hashes.set(entry, contextHash);
  if (hashes.size > MAX_CACHED_CONTEXTS) {
    const oldest = hashes.keys().next().value;
    if (oldest !== undefined) hashes.delete(oldest);
  }
}

export function hostedContextHash(key: HostedContextKey): string | undefined {
  return hashes.get(cacheKey(key));
}

/** Test seam. */
export function resetHostedContextsForTests(): void {
  hashes.clear();
}
