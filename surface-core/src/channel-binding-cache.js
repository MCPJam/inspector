// @ts-nocheck
export class ChannelBindingCache {
	/** @param {{ttlMs?:number,maxEntries?:number}} [options] */
	constructor(options = {}) {
		this.ttlMs = options.ttlMs ?? 60_000;
		this.maxEntries = options.maxEntries ?? 2_000;
		this.entries = new Map();
	}
	key(ctx, conversationId) {
		return `${ctx.tenantId}:${conversationId}`;
	}
	get(ctx, conversationId) {
		const key = this.key(ctx, conversationId);
		const row = this.entries.get(key);
		if (!row) return null;
		if (row.expiresAt <= Date.now()) {
			this.entries.delete(key);
			return null;
		}
		return row.binding;
	}
	set(ctx, conversationId, binding) {
		this.entries.set(this.key(ctx, conversationId), {
			binding,
			expiresAt: Date.now() + this.ttlMs,
		});
		this.trim();
	}
	delete(ctx, conversationId) {
		this.entries.delete(this.key(ctx, conversationId));
	}
	clearTenant(tenantId) {
		for (const key of this.entries.keys())
			if (key.startsWith(`${tenantId}:`)) this.entries.delete(key);
	}
	trim() {
		if (this.entries.size <= this.maxEntries) return;
		for (const [key] of [...this.entries.entries()]
			.sort((a, b) => a[1].expiresAt - b[1].expiresAt)
			.slice(0, this.entries.size - this.maxEntries))
			this.entries.delete(key);
	}
}
