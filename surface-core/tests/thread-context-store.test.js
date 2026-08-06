import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";

import { ThreadContextStore } from "../src/thread-context-store.js";

describe("ThreadContextStore", () => {
	let store;

	beforeEach(() => {
		store = new ThreadContextStore();
	});

	it("stores and retrieves a session", () => {
		store.set("T1", "C1", "ts-1", "sid-abc");
		assert.strictEqual(store.get("T1", "C1", "ts-1"), "sid-abc");
	});

	it("returns null for missing key", () => {
		assert.strictEqual(store.get("T1", "C1", "ts-99"), null);
	});

	it("keeps different threads independent", () => {
		store.set("T1", "C1", "ts-1", "sid-1");
		store.set("T1", "C1", "ts-2", "sid-2");
		assert.strictEqual(store.get("T1", "C1", "ts-1"), "sid-1");
		assert.strictEqual(store.get("T1", "C1", "ts-2"), "sid-2");
	});

	it("isolates identical channel+thread ids across workspaces", () => {
		// Slack channel ids are unique only WITHIN a workspace, so two tenants
		// can genuinely present the same (channel, thread) pair. Team T2 must not
		// see T1's engaged thread — that would make the bot answer unaddressed
		// messages in a channel it was never invited to.
		store.set("T1", "C1", "ts-1", "engaged");
		assert.strictEqual(store.get("T2", "C1", "ts-1"), null);
		store.set("T2", "C1", "ts-1", "engaged-elsewhere");
		assert.strictEqual(store.get("T1", "C1", "ts-1"), "engaged");
		assert.strictEqual(store.get("T2", "C1", "ts-1"), "engaged-elsewhere");
	});

	it("refuses to key a session without a team id", () => {
		assert.throws(
			() => store.set("", "C1", "ts-1", "sid"),
			/requires a tenant id/,
		);
		assert.throws(() => store.get("", "C1", "ts-1"), /requires a tenant id/);
	});

	it("clearTenant drops only that workspace threads", () => {
		store.set("T1", "C1", "ts-1", "sid-1");
		store.set("T1", "C2", "ts-2", "sid-2");
		store.set("T2", "C1", "ts-1", "sid-3");
		store.clearTenant("T1");
		assert.strictEqual(store.get("T1", "C1", "ts-1"), null);
		assert.strictEqual(store.get("T1", "C2", "ts-2"), null);
		assert.strictEqual(store.get("T2", "C1", "ts-1"), "sid-3");
	});

	it("expires entries after TTL", async () => {
		const shortStore = new ThreadContextStore(0);
		shortStore.set("T1", "C1", "ts-1", "sid-abc");
		// Need a tiny delay to ensure Date.now() advances past the stored timestamp
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.strictEqual(shortStore.get("T1", "C1", "ts-1"), null);
	});

	it("evicts oldest entries when max is exceeded", () => {
		const smallStore = new ThreadContextStore(86400, 2);
		smallStore.set("T1", "C1", "ts-1", "sid-1");
		smallStore.set("T1", "C1", "ts-2", "sid-2");
		smallStore.set("T1", "C1", "ts-3", "sid-3");
		assert.strictEqual(smallStore.get("T1", "C1", "ts-1"), null);
		assert.strictEqual(smallStore.get("T1", "C1", "ts-2"), "sid-2");
		assert.strictEqual(smallStore.get("T1", "C1", "ts-3"), "sid-3");
	});

	it("overwrites existing key", () => {
		store.set("T1", "C1", "ts-1", "sid-old");
		store.set("T1", "C1", "ts-1", "sid-new");
		assert.strictEqual(store.get("T1", "C1", "ts-1"), "sid-new");
	});
});
