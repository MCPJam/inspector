import assert from "node:assert/strict";
import test from "node:test";
import { assertConnectUrl, normalizeEnvelope } from "../src/index.js";

/**
 * `normalizeEnvelope` runs on rows from a surface adapter, and some adapters
 * hand it rows they have ALREADY normalized. Before this was idempotent, such
 * a row carried a `role` but no `isBot`/`authorId`, so the derivation found
 * neither and labelled every message "user" — quietly erasing the assistant's
 * own turns from its history and making a multi-turn thread read as a wall of
 * user messages. Nothing errored; the model just lost the plot.
 */

test("preserves the role on a PRE-NORMALIZED row (idempotent)", () => {
	const messages = normalizeEnvelope(
		[
			{ role: "user", content: "what's the status?", timestampMs: 1 },
			{ role: "assistant", content: "all green", timestampMs: 2 },
			{ role: "user", content: "and staging?", timestampMs: 3 },
		],
		{},
	);
	assert.deepEqual(messages, [
		{ role: "user", content: "what's the status?" },
		{ role: "assistant", content: "all green" },
		{ role: "user", content: "and staging?" },
	]);
});

test("normalizing twice is a no-op — the whole point", () => {
	const once = normalizeEnvelope(
		[
			{ authorId: "u1", content: "hi", timestampMs: 1 },
			{ isBot: true, content: "hello", timestampMs: 2 },
		],
		{},
	);
	assert.deepEqual(normalizeEnvelope(once, {}), once);
});

test("still derives the role from RAW authorship fields", () => {
	// The pre-normalized branch must not swallow the real derivation: a row
	// carrying authorship fields is derived from them even if it also has a
	// role, because the raw fields are the authority for a raw row.
	assert.deepEqual(
		normalizeEnvelope(
			[
				{ authorId: "bot-1", content: "from the bot", timestampMs: 1 },
				{ authorId: "human", content: "from a human", timestampMs: 2 },
				{ isBot: true, content: "also the bot", timestampMs: 3 },
			],
			{ botUserId: "bot-1" },
		),
		[
			{ role: "assistant", content: "from the bot" },
			{ role: "user", content: "from a human" },
			{ role: "assistant", content: "also the bot" },
		],
	);
});

test("a role-less raw row still defaults to user", () => {
	assert.deepEqual(normalizeEnvelope([{ content: "anon", timestampMs: 1 }], {}), [
		{ role: "user", content: "anon" },
	]);
});

/**
 * The connect link carries a credential, so which origins it may point at is a
 * security decision. An allowlist is hand-written into an env var, which means
 * it arrives with trailing slashes and paths — none of which string-equal the
 * `url.origin` being compared, so a correctly configured deployment rejected
 * its own link.
 */

test("accepts an allowlist entry with a trailing slash or a path", () => {
	for (const configured of [
		"https://app.mcpjam.com",
		"https://app.mcpjam.com/",
		"https://app.mcpjam.com/api/surface-link",
	]) {
		assert.equal(
			assertConnectUrl("https://app.mcpjam.com/connect?t=abc", [configured]),
			"https://app.mcpjam.com/connect?t=abc",
		);
	}
});

test("a MALFORMED allowlist entry narrows, never widens", () => {
	// Skipping the bad entry is the safe direction. The one good entry still
	// works; the garbage does not become a wildcard.
	assert.equal(
		assertConnectUrl("https://app.mcpjam.com/connect", [
			"not a url at all",
			"https://app.mcpjam.com",
		]),
		"https://app.mcpjam.com/connect",
	);
	assert.throws(
		() => assertConnectUrl("https://app.mcpjam.com/connect", ["¯\\_(ツ)_/¯"]),
		/unconfigured origin/,
	);
});

test("still rejects a link pointing somewhere else entirely", () => {
	assert.throws(
		() =>
			assertConnectUrl("https://evil.example.com/connect", [
				"https://app.mcpjam.com/",
			]),
		/unconfigured origin/,
	);
});

test("still requires HTTPS off loopback", () => {
	assert.throws(
		() =>
			assertConnectUrl("http://app.mcpjam.com/connect", [
				"http://app.mcpjam.com",
			]),
		/HTTPS/,
	);
	// Loopback stays exempt so local development works.
	assert.equal(
		assertConnectUrl("http://localhost:3000/connect", ["http://localhost:3000"]),
		"http://localhost:3000/connect",
	);
});
