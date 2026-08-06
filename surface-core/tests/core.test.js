import assert from "node:assert/strict";
import test from "node:test";
import {
	createChannelBindingCache,
	createThreadBindingCache,
	normalizeThreadMessages,
} from "../src/index.js";

test("normalizes adapter-owned timestamps without parsing snowflakes", () => {
	const messages = normalizeThreadMessages(
		[
			{ id: "1750000000000000000", timestampMs: 1000, content: "before" },
			{ id: "1750000000000000001", timestampMs: 3000, content: "after" },
		],
		{ triggerTimestampMs: 2000 },
	);
	assert.deepEqual(messages, [{ role: "user", content: "before" }]);
});

test("thread negative cache expires and can be forgotten", () => {
	let now = 0;
	const cache = createThreadBindingCache({ ttlMs: 10, now: () => now });
	cache.remember("t", "c", "th");
	assert.equal(cache.has("t", "c", "th"), true);
	now = 11;
	assert.equal(cache.has("t", "c", "th"), false);
});

test("channel reads coalesce and cache null values", async () => {
	let calls = 0;
	const cache = createChannelBindingCache();
	const load = () => {
		calls += 1;
		return null;
	};
	await Promise.all([
		cache.coalesce("t", "c", load),
		cache.coalesce("t", "c", load),
	]);
	assert.equal(calls, 1);
	assert.equal(cache.get("t", "c"), null);
	await cache.coalesce("t", "c", load);
	assert.equal(calls, 1);
});
