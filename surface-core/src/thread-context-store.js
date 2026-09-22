/**
 * Per-thread session state, in memory, with a TTL and a size cap.
 *
 * Keyed by TENANT first: two workspaces can mint identical conversation and
 * thread ids, and letting them share a key would leak one tenant's thread
 * state into another's.
 */
export class ThreadContextStore {
	/** @param {number} [ttlSeconds] @param {number} [maxEntries] */
	constructor(ttlSeconds = 86_400, maxEntries = 1_000) {
		this.ttlMs = ttlSeconds * 1000;
		this.maxEntries = maxEntries;
		/** @type {Map<string, {sessionId: string, timestamp: number}>} */
		this.store = new Map();
	}
	/** @param {string} tenantId @param {string} conversationId @param {string} threadId */
	key(tenantId, conversationId, threadId) {
		if (!tenantId) throw new Error("ThreadContextStore requires a tenant id.");
		return `${tenantId}:${conversationId}:${threadId}`;
	}
	/**
	 * @param {string} tenantId @param {string} conversationId @param {string} threadId
	 * @returns {string | null}
	 */
	get(tenantId, conversationId, threadId) {
		const key = this.key(tenantId, conversationId, threadId);
		const entry = this.store.get(key);
		if (!entry) return null;
		if (Date.now() - entry.timestamp > this.ttlMs) {
			this.store.delete(key);
			return null;
		}
		return entry.sessionId;
	}
	/** @param {string} tenantId @param {string} conversationId @param {string} threadId @param {string} sessionId */
	set(tenantId, conversationId, threadId, sessionId) {
		this.store.set(this.key(tenantId, conversationId, threadId), {
			sessionId,
			timestamp: Date.now(),
		});
		this.cleanup();
	}
	/** @param {string} tenantId */
	clearTenant(tenantId) {
		for (const key of this.store.keys())
			if (key.startsWith(`${tenantId}:`)) this.store.delete(key);
	}
	cleanup() {
		const now = Date.now();
		for (const [key, entry] of this.store)
			if (now - entry.timestamp > this.ttlMs) this.store.delete(key);
		if (this.store.size > this.maxEntries)
			for (const [key] of [...this.store.entries()]
				.sort((a, b) => a[1].timestamp - b[1].timestamp)
				.slice(0, this.store.size - this.maxEntries))
				this.store.delete(key);
	}
}

export const SessionStore = ThreadContextStore;
