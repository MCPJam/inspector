import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChannelBindingCache } from "../src/channel-binding-cache.js";
import { createTurnTargetResolver } from "../src/turn-target.js";

describe("channel binding cache", () => {
	it('distinguishes a cached "no binding" (null) from a miss (undefined)', () => {
		const cache = createChannelBindingCache();
		assert.equal(cache.get("k1"), undefined);
		cache.set("k1", null);
		assert.equal(cache.get("k1"), null);
	});

	it("keys are independent", () => {
		const cache = createChannelBindingCache();
		cache.set("discord:g1:c1", { projectId: "p1" });
		assert.equal(cache.get("discord:g1:c2"), undefined);
	});

	it("expires an entry at its TTL", (t) => {
		t.mock.timers.enable({ apis: ["Date"] });
		try {
			const cache = createChannelBindingCache({ ttlMs: 60_000 });
			cache.set("k1", { projectId: "p1" });
			t.mock.timers.tick(61_000);
			assert.equal(cache.get("k1"), undefined);
		} finally {
			t.mock.timers.reset();
		}
	});

	it("stays bounded under unboundedly many keys", () => {
		const cache = createChannelBindingCache({ maxEntries: 100 });
		for (let i = 0; i < 150; i += 1) cache.set(`k${i}`, null);
		assert.ok(cache.size() <= 100);
	});

	it("coalesces concurrent reads into one call", async () => {
		const cache = createChannelBindingCache();
		let calls = 0;
		const read = async () => {
			calls += 1;
			await new Promise((resolve) => setTimeout(resolve, 5));
			return { projectId: "p1" };
		};
		const [a, b] = await Promise.all([
			cache.coalesce("k1", read),
			cache.coalesce("k1", read),
		]);
		assert.equal(calls, 1);
		assert.deepEqual(a, b);
		assert.deepEqual(cache.get("k1"), { projectId: "p1" });
	});

	it("does NOT cache a read that rejects — an outage is not an answer", async () => {
		const cache = createChannelBindingCache();
		await assert.rejects(
			() => cache.coalesce("k1", async () => Promise.reject(new Error("down"))),
			/down/,
		);
		assert.equal(cache.get("k1"), undefined);
		// A retry after the outage must not be suppressed by a bad cached value.
		let calls = 0;
		await cache.coalesce("k1", async () => {
			calls += 1;
			return null;
		});
		assert.equal(calls, 1);
	});

	it("clearTenant drops cached entries by prefix, leaving other tenants alone", () => {
		const cache = createChannelBindingCache();
		cache.set("discord:g1:c1", { projectId: "p1" });
		cache.set("discord:g2:c1", { projectId: "p2" });
		cache.clearTenant("discord:g1:");
		assert.equal(cache.get("discord:g1:c1"), undefined);
		assert.deepEqual(cache.get("discord:g2:c1"), { projectId: "p2" });
	});

	it("clearTenant also drops an in-flight read, so it cannot repopulate the cache for a tenant that just left", async () => {
		const cache = createChannelBindingCache();
		let resolveRead;
		const pending = cache.coalesce(
			"discord:g1:c1",
			() => new Promise((resolve) => (resolveRead = resolve)),
		);
		cache.clearTenant("discord:g1:");
		resolveRead({ projectId: "stale-org's-project" });
		await pending;
		// The read that was in flight during the purge must not have cached its
		// answer — that answer belongs to the org that just disconnected.
		assert.equal(cache.get("discord:g1:c1"), undefined);
	});
});

describe("createTurnTargetResolver wired to a channel binding cache", () => {
	function backendReturning(channelBinding, link) {
		let channelBindingCalls = 0;
		return {
			calls: () => channelBindingCalls,
			backend: {
				fetchThreadBinding: async () => null,
				fetchChannelBinding: async () => {
					channelBindingCalls += 1;
					return channelBinding;
				},
				fetchAccountLink: async () => link,
			},
		};
	}

	it("asks the backend once for two rapid resolves in the same channel, uncached by default otherwise", async () => {
		const { backend, calls } = backendReturning(
			{ organizationId: "org1", projectId: "proj1" },
			{ organizationId: "org1" },
		);
		const cache = createChannelBindingCache();
		const resolve = createTurnTargetResolver({
			backend,
			surfaceKind: "discord",
			channelBindingCache: cache,
		});
		const ctx = { tenantId: "g1" };
		const [a, b] = await Promise.all([
			resolve(ctx, { conversationId: "c1" }),
			resolve(ctx, { conversationId: "c1" }),
		]);
		assert.equal(calls(), 1);
		assert.equal(a.boundChannel, true);
		assert.equal(b.boundChannel, true);
	});

	it("without a cache, each resolve asks the backend again (unchanged prior behavior)", async () => {
		const { backend, calls } = backendReturning(null, {
			organizationId: "org1",
		});
		const resolve = createTurnTargetResolver({
			backend,
			surfaceKind: "discord",
		});
		const ctx = { tenantId: "g1" };
		await resolve(ctx, { conversationId: "c1" });
		await resolve(ctx, { conversationId: "c1" });
		assert.equal(calls(), 2);
	});
});
