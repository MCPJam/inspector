import assert from "node:assert/strict";
import test from "node:test";
import { snowflakeToMs } from "../history.js";

test("Discord snowflakes are ordered by their embedded millisecond timestamp", () => {
	const first = snowflakeToMs("1750000000000000000");
	const second = snowflakeToMs("1750000000000000001");
	assert.equal(first, second);
	assert.equal(snowflakeToMs("1750000000004194304") > first, true);
});

/**
 * `fetchHistory` returns RAW rows now, and no longer filters by
 * `conversationId`.
 *
 * Both changes exist because of the thread-identity fix. It used to normalize
 * before returning, and `runTurn` normalized again — the second pass saw rows
 * with a `role` but no `authorId`/`isBot`, could not derive authorship, and
 * labelled everything "user", erasing the assistant's own replies from its
 * history. And it filtered fetched messages by
 * `message.channelId === conversationId`, which was harmless until
 * `conversationId` became the thread's PARENT: at that point every message in
 * a thread failed the filter and threads got an empty history.
 */

function fakeChannel(messages) {
	return {
		messages: { fetch: async () => new Map(messages.map((m) => [m.id, m])) },
	};
}

test("returns RAW rows for the envelope normalizer to own", async () => {
	const { fetchHistory } = await import("../history.js");
	const rows = await fetchHistory({
		channel: fakeChannel([
			{
				id: "1750000000000000000",
				content: "hello",
				channelId: "thread-1",
				author: { id: "u1", bot: false },
			},
			{
				id: "1750000000004194304",
				content: "hi back",
				channelId: "thread-1",
				author: { id: "bot", bot: true },
			},
		]),
	});

	// Raw authorship fields, not a pre-computed `role`.
	assert.deepEqual(
		rows.map((row) => ({ authorId: row.authorId, isBot: row.isBot })),
		[
			{ authorId: "u1", isBot: false },
			{ authorId: "bot", isBot: true },
		],
	);
	assert.equal(
		rows.some((row) => "role" in row),
		false,
	);
});

test("keeps THREAD messages — the parent-channel conversationId used to drop them all", async () => {
	const { fetchHistory } = await import("../history.js");
	const rows = await fetchHistory({
		channel: fakeChannel([
			{
				id: "1750000000000000000",
				content: "in the thread",
				// The thread's own id — which no longer equals `conversationId`.
				channelId: "thread-1",
				author: { id: "u1", bot: false },
			},
		]),
	});
	assert.equal(rows.length, 1);
	assert.equal(rows[0].content, "in the thread");
});
