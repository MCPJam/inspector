// @ts-nocheck

const snowflakeToMs = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);

/**
 * Recent messages from the channel (or thread) the turn is happening in.
 *
 * Returns RAW rows — `{ id, content, timestampMs, authorId, isBot }` — not
 * normalized ones. `runTurn` normalizes, and it used to normalize a second
 * time on top of this function's already-normalized output. That second pass
 * saw a row with a `role` but no `authorId`/`isBot`, could not derive
 * authorship, and labelled everything "user": the assistant's own replies
 * vanished from the history it was given. `surface-core`'s normalizer is
 * idempotent now, so double-normalizing is survivable — but normalizing
 * exactly once, at the one place that owns the envelope, is the actual fix.
 *
 * NO `conversationId` FILTER. There used to be one — keep only messages whose
 * `channelId` matches `conversationId` — and it was load-bearing right up
 * until `conversationId` became the thread's PARENT channel. At that point
 * every message in a thread failed the filter and threads got an EMPTY
 * history, which reads like the model forgetting rather than like a bug. The
 * filter was never doing real work anyway: `channel.messages.fetch` only
 * returns messages from that channel.
 */
export async function fetchHistory({ channel, limit = 50 }) {
	const messages = await channel.messages.fetch({ limit });
	return [...messages.values()].map((message) => ({
		id: message.id,
		content: message.content,
		// Discord snowflakes carry their own timestamp; deriving it avoids
		// trusting a `createdTimestamp` that a partial message may not have.
		timestampMs: snowflakeToMs(message.id),
		authorId: message.author?.id,
		isBot: Boolean(message.author?.bot),
	}));
}

export { snowflakeToMs };
