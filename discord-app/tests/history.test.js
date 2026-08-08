import assert from "node:assert/strict";
import test from "node:test";
import { runTurn } from "@mcpjam/surface-core";
import { fetchHistory, snowflakeToMs } from "../history.js";

const DISCORD_EPOCH_MS = 1420070400000n;

/** Build a snowflake for a given millisecond, with an in-millisecond counter. */
const snowflakeAt = (ms, increment = 0) =>
	String(((BigInt(ms) - DISCORD_EPOCH_MS) << 22n) + BigInt(increment));

/**
 * A channel whose `messages.fetch()` behaves like discord.js: newest-first.
 * Every ordering assertion below depends on that, so the fake must not sort.
 */
const fakeChannel = (rows) => {
	const fetchCalls = [];
	return {
		fetchCalls,
		messages: {
			async fetch(options) {
				fetchCalls.push(options);
				const newestFirst = [...rows].sort((a, b) =>
					a.id.length === b.id.length
						? b.id.localeCompare(a.id)
						: b.id.length - a.id.length,
				);
				return new Map(newestFirst.map((row) => [row.id, row]));
			},
		},
	};
};

const message = (id, content, author) => ({ id, content, author });
const human = (userId) => ({ id: userId, bot: false });
const bot = (userId) => ({ id: userId, bot: true });

test("Discord snowflakes are ordered by their embedded millisecond timestamp", () => {
	const first = snowflakeToMs("1750000000000000000");
	const second = snowflakeToMs("1750000000000000001");
	assert.equal(first, second);
	assert.equal(snowflakeToMs("1750000000004194304") > first, true);
});

test("fetchHistory returns raw rows, never normalized ones", async () => {
	const channel = fakeChannel([
		message(snowflakeAt(1_700_000_000_000), "hello", human("U1")),
	]);

	const rows = await fetchHistory({ channel, botUserId: "BOT" });

	assert.deepEqual(Object.keys(rows[0]).sort(), [
		"authorId",
		"content",
		"id",
		"isBot",
		"timestampMs",
	]);
	// A `role` key here would mean this module normalized, and the core's second
	// pass would then flatten every assistant turn back to "user".
	assert.equal("role" in rows[0], false);
});

test("fetchHistory sorts oldest-first even though Discord returns newest-first", async () => {
	const channel = fakeChannel([
		message(snowflakeAt(1_700_000_003_000), "third", human("U1")),
		message(snowflakeAt(1_700_000_001_000), "first", human("U1")),
		message(snowflakeAt(1_700_000_002_000), "second", human("U1")),
	]);

	const rows = await fetchHistory({ channel, botUserId: "BOT" });

	assert.deepEqual(
		rows.map((row) => row.content),
		["first", "second", "third"],
	);
});

test("fetchHistory tie-breaks same-millisecond messages on the snowflake", async () => {
	const channel = fakeChannel([
		message(snowflakeAt(1_700_000_001_000, 2), "c", human("U1")),
		message(snowflakeAt(1_700_000_001_000, 0), "a", human("U1")),
		message(snowflakeAt(1_700_000_001_000, 1), "b", human("U1")),
	]);

	const rows = await fetchHistory({ channel, botUserId: "BOT" });

	assert.deepEqual(
		rows.map((row) => row.content),
		["a", "b", "c"],
	);
	assert.equal(rows[0].timestampMs, rows[2].timestampMs);
});

test("fetchHistory flags this bot and other bots as bot authors", async () => {
	const channel = fakeChannel([
		message(snowflakeAt(1_700_000_001_000), "human", human("U1")),
		message(snowflakeAt(1_700_000_002_000), "us", bot("BOT")),
		message(snowflakeAt(1_700_000_003_000), "other bot", bot("OTHER")),
	]);

	const rows = await fetchHistory({ channel, botUserId: "BOT" });

	assert.deepEqual(
		rows.map((row) => row.isBot),
		[false, true, true],
	);
});

test("fetchHistory reads the channel it is handed and does not filter by conversationId", async () => {
	// discord.js hands us the ThreadChannel for a message inside a thread. Under
	// the thread-aware identity derivation `conversationId` is the PARENT channel,
	// so filtering rows on it would leave every in-thread turn with no history.
	const channel = fakeChannel([
		message(snowflakeAt(1_700_000_001_000), "in the thread", human("U1")),
	]);

	const rows = await fetchHistory({
		channel,
		conversationId: "parent-channel",
		threadId: "thread-channel",
		botUserId: "BOT",
	});

	assert.deepEqual(
		rows.map((row) => row.content),
		["in the thread"],
	);
});

test("fetchHistory excludes same-millisecond messages posted after the trigger", async () => {
	// Truncating a snowflake to milliseconds discards the per-millisecond counter,
	// so the core's `timestampMs > triggerMs` cutoff compares these as equal and
	// keeps the later message — which the snowflake tie-break then sorts LAST,
	// ahead of the very message the model is supposed to be answering.
	const triggerId = snowflakeAt(1_700_000_001_000, 5);
	const channel = fakeChannel([
		message(snowflakeAt(1_700_000_001_000, 9), "raced in after", human("U2")),
		message(triggerId, "the trigger", human("U1")),
		message(snowflakeAt(1_700_000_001_000, 1), "just before", human("U1")),
	]);

	const rows = await fetchHistory({
		channel,
		triggerMessageId: triggerId,
		botUserId: "BOT",
	});

	assert.deepEqual(
		rows.map((row) => row.content),
		["just before", "the trigger"],
	);
	// All three share one timestamp, so only an id comparison can separate them.
	assert.equal(rows[0].timestampMs, rows[1].timestampMs);
});

test("fetchHistory keeps every row when no trigger id is supplied", async () => {
	const channel = fakeChannel([
		message(snowflakeAt(1_700_000_002_000), "second", human("U1")),
		message(snowflakeAt(1_700_000_001_000), "first", human("U1")),
	]);

	const rows = await fetchHistory({ channel, botUserId: "BOT" });

	assert.deepEqual(
		rows.map((row) => row.content),
		["first", "second"],
	);
});

test("fetchHistory forwards the requested limit to Discord", async () => {
	const channel = fakeChannel([]);
	await fetchHistory({ channel, limit: 12, botUserId: "BOT" });
	assert.deepEqual(channel.fetchCalls, [{ limit: 12 }]);
});

test("a turn normalizes history exactly once: roles survive, order is chronological, later messages are cut", async () => {
	const triggerMs = 1_700_000_003_000;
	const channel = fakeChannel([
		message(
			snowflakeAt(1_700_000_004_000),
			"posted after the trigger",
			human("U1"),
		),
		message(snowflakeAt(triggerMs), "and now?", human("U1")),
		message(snowflakeAt(1_700_000_002_000), "earlier answer", bot("BOT")),
		message(snowflakeAt(1_700_000_001_000), "earlier question", human("U1")),
	]);
	/** @type {any[]} */
	let seen = [];

	await runTurn({
		ref: {
			surfaceKind: "discord",
			tenantId: "G1",
			conversationId: "C1",
			threadId: "T1",
		},
		fetchHistory: (args) =>
			fetchHistory({ ...args, channel, botUserId: "BOT" }),
		deliver: async () => ({ handles: [] }),
		turn: async (history) => {
			seen = history;
			return { reply: "ok" };
		},
		triggerTimestampMs: triggerMs,
	});

	assert.deepEqual(seen, [
		{ role: "user", content: "earlier question" },
		// Would be "user" if history.js normalized before the core did.
		{ role: "assistant", content: "earlier answer" },
		{ role: "user", content: "and now?" },
	]);
	// The trigger is the last thing the model sees; nothing newer leaks in.
	assert.equal(seen.at(-1).content, "and now?");
});

test("a turn keeps the newest messages when the byte budget forces a trim", async () => {
	// Each message is capped to ~8 KB on its own, so the aggregate 96 KB budget
	// only bites once there are more than a dozen of them.
	const filler = "x".repeat(20_000);
	const triggerMs = 1_700_000_030_000;
	const channel = fakeChannel(
		Array.from({ length: 20 }, (_, index) =>
			message(
				snowflakeAt(1_700_000_001_000 + index * 1_000),
				`${index}:${filler}`,
				human("U1"),
			),
		),
	);
	/** @type {any[]} */
	let seen = [];

	await runTurn({
		ref: { surfaceKind: "discord", tenantId: "G1", conversationId: "C1" },
		fetchHistory: (args) =>
			fetchHistory({ ...args, channel, botUserId: "BOT" }),
		deliver: async () => ({ handles: [] }),
		turn: async (history) => {
			seen = history;
			return { reply: "ok" };
		},
		triggerTimestampMs: triggerMs,
	});

	assert.equal(seen.length < 20, true);
	// Oldest-first ordering is what makes the aggregate budget drop the OLDEST
	// messages. Reversed input would have thrown away the trigger instead.
	assert.equal(seen.at(-1).content.startsWith("19:"), true);
	assert.equal(seen[0].content.startsWith("0:"), false);
});
