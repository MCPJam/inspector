/**
 * Discord snowflakes are not timestamps. `createdTimestamp` is the adapter's
 * canonical millisecond value and is what the shared runner uses for ordering.
 * @param {any} channel
 * @param {{conversationId:string,threadId?:string,triggerMessageId:string,limit:number}} args
 */
export async function fetchHistory(channel, args) {
	const collection = await channel.messages.fetch({
		limit: Math.min(args.limit || 50, 100),
	});
	return [...collection.values()]
		.sort((a, b) => a.createdTimestamp - b.createdTimestamp)
		.map((message) => ({
			authorId: message.author?.id,
			isBot: Boolean(message.author?.bot),
			content: message.content || "",
			timestampMs: message.createdTimestamp,
			messageId: message.id,
		}));
}
