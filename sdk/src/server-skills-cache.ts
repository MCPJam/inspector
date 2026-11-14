/**
 * Verified skill bytes, cached in memory per manager.
 *
 * The spec says hosts SHOULD cache what they retrieve, and that a cached file
 * whose digest matches the current entry can be served without fetching it
 * again. The key carries the digest, so a hit is by definition a match; the
 * bytes still go through the same verification as a fresh read, which is
 * cheap and keeps one code path. In memory and host-only, so the spec's
 * on-disk rules (write isolation, re-digesting on access, exclusion from
 * skill discovery paths) do not arise. Bounded by entries and by bytes;
 * oldest insertion goes first.
 */

const VERIFIED_READ_CACHE_MAX_ENTRIES = 256;
const VERIFIED_READ_CACHE_MAX_BYTES = 32 * 1024 * 1024;

interface VerifiedReadCache {
  entries: Map<string, string>;
  bytes: number;
}

const verifiedReadCaches = new WeakMap<object, VerifiedReadCache>();

function verifiedReadCacheFor(manager: object): VerifiedReadCache {
  let cache = verifiedReadCaches.get(manager);
  if (!cache) {
    cache = { entries: new Map(), bytes: 0 };
    verifiedReadCaches.set(manager, cache);
  }
  return cache;
}

function verifiedReadKey(serverId: string, uri: string, digest: string) {
  return `${serverId}\n${uri}\n${digest}`;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** The cached text for this exact digest, or `undefined` on a miss. */
export function cachedVerifiedText(
  manager: object,
  serverId: string,
  uri: string,
  digest: string | undefined
): string | undefined {
  if (digest === undefined) return undefined;
  const cache = verifiedReadCaches.get(manager);
  const key = verifiedReadKey(serverId, uri, digest);
  const text = cache?.entries.get(key);
  if (cache && text !== undefined) {
    // Refresh insertion order so a file in use outlives one that is not.
    cache.entries.delete(key);
    cache.entries.set(key, text);
  }
  return text;
}

/** Records text that verified against `digest`. Call only after verifying. */
export function rememberVerifiedText(
  manager: object,
  serverId: string,
  uri: string,
  digest: string,
  text: string
): void {
  const size = byteLength(text);
  if (size > VERIFIED_READ_CACHE_MAX_BYTES) return;
  const cache = verifiedReadCacheFor(manager);
  const key = verifiedReadKey(serverId, uri, digest);
  const previous = cache.entries.get(key);
  if (previous !== undefined) {
    cache.bytes -= byteLength(previous);
    cache.entries.delete(key);
  }
  cache.entries.set(key, text);
  cache.bytes += size;
  while (
    cache.entries.size > VERIFIED_READ_CACHE_MAX_ENTRIES ||
    cache.bytes > VERIFIED_READ_CACHE_MAX_BYTES
  ) {
    const oldest = cache.entries.keys().next();
    if (oldest.done) break;
    const evicted = cache.entries.get(oldest.value)!;
    cache.entries.delete(oldest.value);
    cache.bytes -= byteLength(evicted);
  }
}

/** Drops every cached read for one server, e.g. when the user removes it. */
export function forgetVerifiedServerSkillReads(
  manager: object,
  serverId: string
): void {
  const cache = verifiedReadCaches.get(manager);
  if (!cache) return;
  for (const [key, text] of [...cache.entries]) {
    if (!key.startsWith(`${serverId}\n`)) continue;
    cache.entries.delete(key);
    cache.bytes -= byteLength(text);
  }
}
