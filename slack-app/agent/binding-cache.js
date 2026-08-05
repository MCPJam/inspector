/**
 * TTL cache for channel→project bindings.
 *
 * Every turn in a channel asks whether that channel is bound, which puts a
 * backend round trip inside Slack's 3-second ack budget on the hot path. Sixty
 * seconds of caching takes it off that path without making a stale binding
 * interesting: the org-settings UI already promises changes take effect within
 * a minute.
 *
 * NEGATIVES ARE CACHED, deliberately, and this is the one place this file
 * departs from `installations/store.js` — which pointedly does NOT cache them.
 * The difference is what the two answers mean:
 *
 *   - an installation lookup answers "may this workspace's events be
 *     authorized at all". A cached miss there would keep a workspace that just
 *     installed locked out for the whole TTL, and the answer is a CREDENTIAL,
 *     so the cost of being wrong is an auth failure.
 *   - a binding lookup answers "does this channel have a preferred project".
 *     MOST CHANNELS HAVE NO BINDING, so a negative is the common case, and
 *     refusing to cache it would mean the cache does nothing at all for the
 *     traffic that needs it most. Being ≤60 s stale on an add or a remove
 *     costs one turn landing in the speaker's own default project — a settings
 *     lag, not an authorization failure.
 *
 * Process-local, like every cache in this app: the Railway service is pinned
 * to one replica (see railway.toml).
 */

/** Matches the inspector's org-policy cache and the UI's "within a minute". */
const CACHE_TTL_MS = 60 * 1000;

/**
 * Hard bound. A public app is installed by unboundedly many workspaces, each
 * with unboundedly many channels, and a channel that is asked about once and
 * never again would otherwise be retained forever.
 */
const CACHE_MAX_ENTRIES = 5000;

/**
 * @typedef {Object} ChannelBinding
 * @property {string} organizationId
 * @property {string} projectId
 * @property {string} [channelId]
 * @property {number} [createdAt]
 */

/** @type {Map<string, { binding: ChannelBinding | null, expiresAt: number }>} */
const cache = new Map();

/**
 * @param {string} teamId
 * @param {string} channelId
 */
function cacheKey(teamId, channelId) {
  return `${teamId}:${channelId}`;
}

/**
 * Drop expired entries, then oldest-first down to the bound. Called on write,
 * so the map is swept by the same traffic that grows it.
 */
function evictIfNeeded() {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const byExpiry = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (const [key] of byExpiry.slice(0, cache.size - CACHE_MAX_ENTRIES)) {
    cache.delete(key);
  }
}

/**
 * A cached answer, or `undefined` for a miss.
 *
 * `null` is a real answer here — "this channel has no binding" — so callers
 * must distinguish it from `undefined`.
 *
 * @param {string} teamId
 * @param {string} channelId
 * @returns {ChannelBinding | null | undefined}
 */
export function getCachedChannelBinding(teamId, channelId) {
  const key = cacheKey(teamId, channelId);
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.binding;
}

/**
 * @param {string} teamId
 * @param {string} channelId
 * @param {ChannelBinding | null} binding
 */
export function setCachedChannelBinding(teamId, channelId, binding) {
  cache.set(cacheKey(teamId, channelId), {
    binding,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  evictIfNeeded();
}

/** Test helper: start from a cold cache. */
export function clearChannelBindingCache() {
  cache.clear();
}

/** Test helper: observe occupancy. */
export function channelBindingCacheSize() {
  return cache.size;
}

export const CHANNEL_BINDING_CACHE_TTL_MS = CACHE_TTL_MS;
export const CHANNEL_BINDING_CACHE_MAX_ENTRIES = CACHE_MAX_ENTRIES;
