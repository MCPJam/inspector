// @ts-nocheck
/** Negative cache for a thread lookup. It is intentionally separate from the
 * durable channel binding cache: a missing thread binding is short-lived and
 * must never mask a first writer. */
export class ThreadBindingCache {
	/** @param {{ttlMs?:number,maxEntries?:number}} [options] */
	constructor(options = {}) {
		this.ttlMs = options.ttlMs ?? 10_000;
		this.maxEntries = options.maxEntries ?? 5_000;
		this.entries = new Map();
	}
	key(ctx, conversationId, threadId) {
		return `${ctx.tenantId}:${conversationId}:${threadId}`;
	}
	has(ctx, conversationId, threadId) {
		const key = this.key(ctx, conversationId, threadId);
		const expiresAt = this.entries.get(key);
		if (!expiresAt) return false;
		if (expiresAt <= Date.now()) {
			this.entries.delete(key);
			return false;
		}
		return true;
	}
	setMissing(ctx, conversationId, threadId) {
		this.entries.set(
			this.key(ctx, conversationId, threadId),
			Date.now() + this.ttlMs,
		);
		if (this.entries.size > this.maxEntries)
			this.entries.delete(this.entries.keys().next().value);
	}
	clearTenant(tenantId) {
		for (const key of this.entries.keys())
			if (key.startsWith(`${tenantId}:`)) this.entries.delete(key);
	}
}
