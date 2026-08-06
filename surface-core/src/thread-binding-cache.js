// @ts-nocheck — not yet adopted by slack-app. Typed as each module is
// migrated off its slack-app twin; the marker tracks that remaining work.
/** Negative cache for a thread lookup. It is intentionally separate from the
 * durable channel binding cache: a missing thread binding is short-lived and
 * must never mask a first writer. */
export class ThreadBindingCache {
	/** @param {{ttlMs?:number,maxEntries?:number}} [options] */
	constructor(options = {}) {
		this.ttlMs = options.ttlMs ?? 10_000;
		this.maxEntries = options.maxEntries ?? 5_000;
		this.now = options.now ?? Date.now;
		this.entries = new Map();
	}
	key(ctx, conversationId, threadId) {
		return `${ctx.tenantId}:${conversationId}:${threadId}`;
	}
	has(ctx, conversationId, threadId) {
		const key = this.key(ctx, conversationId, threadId);
		const expiresAt = this.entries.get(key);
		if (!expiresAt) return false;
		if (expiresAt <= this.now()) {
			this.entries.delete(key);
			return false;
		}
		return true;
	}
	setMissing(ctx, conversationId, threadId) {
		this.entries.set(
			this.key(ctx, conversationId, threadId),
			this.now() + this.ttlMs,
		);
		if (this.entries.size > this.maxEntries)
			this.entries.delete(this.entries.keys().next().value);
	}
	clearTenant(tenantId) {
		for (const key of this.entries.keys())
			if (key.startsWith(`${tenantId}:`)) this.entries.delete(key);
	}
}

export function createThreadBindingCache(options = {}) {
	const cache = new ThreadBindingCache(options);
	return {
		has: (tenantId, conversationId, threadId) =>
			cache.has({ tenantId }, conversationId, threadId),
		remember: (tenantId, conversationId, threadId) =>
			cache.setMissing({ tenantId }, conversationId, threadId),
		forget: (tenantId, conversationId, threadId) =>
			cache.entries.delete(`${tenantId}:${conversationId}:${threadId}`),
		clear: () => cache.entries.clear(),
	};
}
