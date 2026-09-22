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
 *    tempting to normalize here and hand back `{role, content}` — don't. The
 *    core's second pass would see rows with no `isBot`/`authorId`, and until
 *    that normalizer was made idempotent it re-attributed every assistant
 *    message to `role:"user"`, erasing the bot's own turns from the history it
 *    was given. It now preserves an existing `role`, so a double pass survives
 *    — but `timestampMs` is still dropped on the way out, so the core's
 *    newer-than-trigger cutoff would go blind. Return the fields the core
 *    normalizer reads and let it own the mapping.
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
 * The newer-than-trigger cutoff runs HERE, on snowflakes, and not only in the
 * core. The core compares `timestampMs`, and truncating a snowflake to
 * milliseconds throws away the 12-bit per-millisecond counter — so a message
 * posted just after the trigger within the SAME millisecond compares equal, and
 * the core's `>` test keeps it. The snowflake tie-break below would then sort
 * that message LAST, handing the model a turn the user had not sent yet as the
 * thing it must answer. Discord ids are the true total order and only this
 * adapter knows that, so filter on `triggerMessageId` here and leave the core's
 * timestamp cutoff as the surface-neutral backstop. `<= 0` keeps the trigger
 * itself.
 *
 * @param {{ channel: any, triggerMessageId?: string, limit?: number, botUserId?: string }} args
 */
export async function fetchHistory({
	channel,
	triggerMessageId,
	limit = 50,
	botUserId,
}) {
	const fetched = await channel.messages.fetch({ limit });
	const rows = [...fetched.values()]
		.filter(
			(message) =>
				!triggerMessageId ||
				compareSnowflakes(message.id, triggerMessageId) <= 0,
		)
		.map((message) => ({
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
