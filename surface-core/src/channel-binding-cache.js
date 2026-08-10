// @ts-nocheck — not yet adopted by slack-app. Typed as each module is
// migrated off its slack-app twin; the marker tracks that remaining work.

/**
 * TTL cache for channel→project bindings, extracted from the correctness
 * properties slack-app/agent/binding-cache.js has carried in production.
 *
 * Every turn in a channel asks whether that channel is bound, which puts a
 * backend round trip on the hot path of every single message. A short TTL
 * takes it off that path without making a stale binding interesting: the
 * org-settings UI that writes these already promises changes take effect
 * within a minute, so caching for that same window costs nothing new.
 *
 * NEGATIVES ARE CACHED, deliberately. Most channels have no binding, so a
 * cache that refused to remember "no binding here" would do nothing for the
 * traffic that needs it most — the common case, not the rare one. This is
 * safe specifically BECAUSE a channel binding is written by an admin through
 * a separate settings flow, never by the turn that is reading it: there is
 * no same-request write-then-stale-read race to worry about the way there
 * would be for a THREAD binding, which the reading turn may itself go on to
 * create a moment later. (That coupling is why this module does not also
 * cover thread bindings — see the note on `resolveTurnTarget` in
 * `turn-target.js`.)
 *
 * Process-local. A surface that runs more than one replica of the same
 * process needs a shared cache or none at all; nothing here coordinates
 * across processes.
 */

const DEFAULT_TTL_MS = 60 * 1000;
const DEFAULT_MAX_ENTRIES = 5000;

/**
 * @typedef {Object} ChannelBindingCache
 * @property {(key: string) => any} get Cached value, or `undefined` for a
 *   miss. `null` is a real cached answer ("no binding") — callers must
 *   distinguish it from `undefined` ("never asked, or expired").
 * @property {(key: string, value: any) => void} set
 * @property {(key: string, read: () => Promise<any>) => Promise<any>} coalesce
 *   Share one in-flight read per key, then cache its result — unless a
 *   `clearTenant` invalidated that exact read while it was in flight.
 * @property {(prefix: string) => void} clearTenant Drop every cached AND
 *   in-flight entry whose key starts with `prefix`.
 * @property {() => number} size
 */

/**
 * @param {{ttlMs?: number, maxEntries?: number}} [options]
 * @returns {ChannelBindingCache}
 */
export function createChannelBindingCache(options = {}) {
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

	/** @type {Map<string, {value: any, expiresAt: number}>} */
	const cache = new Map();
	/**
	 * Reads currently in flight, keyed the same way as the cache. Two turns
	 * racing in the same channel — the common cold-start burst — would
	 * otherwise each make a round trip, and the SLOWER answer could land last
	 * and overwrite a value that was already correct. Sharing one promise
	 * removes both the duplicate call and the race.
	 * @type {Map<string, Promise<any>>}
	 */
	const inflight = new Map();

	/**
	 * Drop expired entries, then oldest-first down to the bound. Only runs
	 * when the map is actually near its bound: this executes on every write,
	 * and the whole point of this cache is to stay off the turn's hot path,
	 * so an unconditional full-map walk on every insert would defeat it.
	 */
	function evictIfNeeded() {
		if (cache.size <= maxEntries) return;
		const now = Date.now();
		for (const [key, entry] of cache) {
			if (entry.expiresAt <= now) cache.delete(key);
		}
		if (cache.size <= maxEntries) return;
		const byExpiry = [...cache.entries()].sort(
			(a, b) => a[1].expiresAt - b[1].expiresAt,
		);
		for (const [key] of byExpiry.slice(0, cache.size - maxEntries))
			cache.delete(key);
	}

	function get(key) {
		const hit = cache.get(key);
		if (!hit) return undefined;
		if (hit.expiresAt <= Date.now()) {
			cache.delete(key);
			return undefined;
		}
		return hit.value;
	}

	function set(key, value) {
		cache.set(key, { value, expiresAt: Date.now() + ttlMs });
		evictIfNeeded();
	}

	function coalesce(key, read) {
		const existing = inflight.get(key);
		if (existing) return existing;
		const pending = read()
			.then((value) => {
				// Only cache if this exact read was not invalidated by a
				// clearTenant while it was running — otherwise a purge could be
				// raced by an in-flight read for the workspace that just left,
				// repopulating the cache with the departing tenant's answer.
				if (inflight.get(key) === pending) set(key, value);
				return value;
			})
			.finally(() => {
				if (inflight.get(key) === pending) inflight.delete(key);
			});
		inflight.set(key, pending);
		return pending;
	}

	function clearTenant(prefix) {
		for (const key of cache.keys())
			if (key.startsWith(prefix)) cache.delete(key);
		for (const key of inflight.keys())
			if (key.startsWith(prefix)) inflight.delete(key);
	}

	return {
		get,
		set,
		coalesce,
		clearTenant,
		size: () => cache.size,
	};
}
