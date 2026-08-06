// @ts-nocheck
import { normalizeThreadMessages } from "@mcpjam/surface-core";

const snowflakeToMs = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);

export async function fetchHistory({
	channel,
	conversationId,
	triggerMessageId,
	limit = 50,
	botUserId,
}) {
	const messages = await channel.messages.fetch({ limit });
	const raw = [...messages.values()]
		.filter(
			(message) => !conversationId || message.channelId === conversationId,
		)
		.map((message) => ({
			id: message.id,
			content: message.content,
			timestampMs: snowflakeToMs(message.id),
			authorId: message.author?.id,
			isBot: message.author?.id === botUserId,
		}));
	return normalizeThreadMessages(raw, {
		triggerTimestampMs: triggerMessageId
			? snowflakeToMs(triggerMessageId)
			: undefined,
		botUserId,
	});
}

export { snowflakeToMs };
