// @ts-nocheck
const DISCORD_EPOCH_MS = 1420070400000n;

/**
 * Discord snowflakes embed their creation time in the high 42 bits, so the id
 * alone is a total chronological order across the whole platform. Truncating to
 * milliseconds loses that: two messages created in the same millisecond share a
 * timestamp, which is why ordering tie-breaks on the id and not the timestamp.
 */
const snowflakeToMs = (id) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);

/**
 * Compare two decimal snowflake strings numerically without allocating BigInts
 * per comparison. Snowflakes never carry leading zeros, so a shorter string is
 * always the smaller number and equal-length strings compare lexicographically.
 */
const compareSnowflakes = (a, b) =>
	a.length === b.length ? (a < b ? -1 : a > b ? 1 : 0) : a.length - b.length;

/**
 * Fetch the conversation context for a Discord trigger as RAW rows.
 *
 * Two invariants are load-bearing here.
 *
 * 1. Normalization happens exactly once, in surface-core's turn runner. It is
 *    tempting to normalize here and hand back `{role, content}` — that is a
 *    correctness bug, not a redundancy. The core's second pass would see rows
 *    with no `isBot`/`authorId`/`timestampMs`, so every assistant message is
 *    silently re-attributed to `role:"user"` and the newer-than-trigger cutoff
 *    can never fire. Return the fields the core normalizer reads and let it own
 *    the mapping.
 *
 * 2. Rows come back sorted OLDEST-first. `messages.fetch()` returns newest-first
 *    and the core trims from the FRONT of the array (both `slice(-MAX_MESSAGES)`
 *    and the aggregate byte budget drop the oldest entries). Handing it an
 *    unsorted list therefore both reverses the conversation the model sees and
 *    makes the budget discard the NEWEST messages — including the trigger.
 *
 * `channel` must be the channel the trigger message was posted in. discord.js
 * hands us the ThreadChannel for a message inside a thread, so reading from it
 * scopes history to the thread instead of the parent channel's last 50. History
 * is deliberately not filtered by `conversationId`: under the thread-aware
 * identity derivation `conversationId` is the PARENT channel, which would match
 * nothing in a thread and leave every turn with an empty history.
 *
 * The trigger message itself is kept — the core cutoff is `>`, not `>=` — while
 * anything posted after it is dropped there, so a racing message cannot leak
 * into the context of a turn that predates it. That is why this function needs
 * no `triggerMessageId`: the core filters on `triggerTimestampMs`.
 *
 * @param {{ channel: any, limit?: number, botUserId?: string }} args
 */
export async function fetchHistory({ channel, limit = 50, botUserId }) {
	const fetched = await channel.messages.fetch({ limit });
	const rows = [...fetched.values()].map((message) => ({
		id: message.id,
		content: message.content,
		timestampMs: snowflakeToMs(message.id),
		authorId: message.author?.id,
		// Mirrors Slack's attribution (`Boolean(bot_id) || user === botUserId`):
		// any bot's message is `assistant`, not a human turn we should answer.
		isBot: Boolean(message.author?.bot) || message.author?.id === botUserId,
	}));
	rows.sort(
		(a, b) => a.timestampMs - b.timestampMs || compareSnowflakes(a.id, b.id),
	);
	return rows;
}

export { snowflakeToMs };
