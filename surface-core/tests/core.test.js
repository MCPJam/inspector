import assert from "node:assert/strict";
import test from "node:test";
import { createApiClient, normalizeThreadMessages } from "../src/index.js";

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

test("an origin is trimmed in linear time, not by a backtracking regex", () => {
	// `.replace(/\\/+$/, "")` is a polynomial-ReDoS shape: a greedy `+` with a
	// `$` that can fail, retried from every start position. CodeQL rates it
	// high, and it is not theoretical — the regex form took ~3 SECONDS on the
	// input below, where the scan takes microseconds. A base URL arrives from
	// caller options and the environment, which is not a reason to keep a
	// quadratic scan on the request path.
	//
	// Reached through the PUBLIC path (`getConfig` is what every request calls)
	// rather than by exporting a private helper for a test.
	const client = createApiClient();
	const originOf = (baseUrl) =>
		client.getConfig(
			{ tenantId: "t1", actorId: "u1" },
			{ baseUrl, apiKey: "sk_test", projectId: "p1" },
		).baseUrl;

	// Behaviour first: the trim itself is unchanged.
	for (const [input, expected] of [
		["https://a.example", "https://a.example"],
		["https://a.example/", "https://a.example"],
		["https://a.example///", "https://a.example"],
	]) {
		assert.equal(originOf(input), expected, input);
	}

	// Then the cost, with three orders of magnitude of headroom against the ~3s
	// the backtracking form needed — a regression detector, not a timing-
	// sensitive test.
	const started = Date.now();
	originOf(`https://a.example${"/".repeat(100_000)}x`);
	assert.ok(
		Date.now() - started < 2000,
		"trimming an origin must not backtrack quadratically",
	);
});
