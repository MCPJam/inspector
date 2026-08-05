/** @typedef {{surfaceKind:'discord',tenantId:string,actorId:string,conversationId:string,threadId:string,isGuild:boolean}} DiscordContext */

/** @param {any} message @param {any} client */
export function contextFromMessage(message, client) {
	const guildId = message.guildId || message.guild?.id;
	if (!guildId) return null;
	const actorId = message.author?.id;
	const conversationId = message.channelId;
	if (!actorId || !conversationId) return null;
	return {
		surfaceKind: "discord",
		tenantId: guildId,
		actorId,
		conversationId,
		threadId: message.reference?.messageId || message.id,
		isGuild: true,
		clientUserId: client?.user?.id,
	};
}

/** @param {any} message @param {any} client */
export function isBotMention(message, client) {
	const botId = client?.user?.id;
	return Boolean(
		botId && message.guildId && message.mentions?.users?.has?.(botId),
	);
}

/** @param {any} message @param {any} client */
export function promptFromMessage(message, client) {
	const botId = client?.user?.id;
	const text = String(message.content || "")
		.replace(botId ? new RegExp(`<@!?${botId}>`, "g") : /$^/, "")
		.trim();
	return text || "Please help with this conversation.";
}
