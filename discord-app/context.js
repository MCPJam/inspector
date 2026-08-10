// @ts-nocheck

/**
 * Discord channel/thread identity → the `conversationId` / `threadId` pair the
 * rest of the system is built around.
 *
 * THIS IS THE FILE THAT WAS WRONG. `app.js` used to build refs inline as:
 *
 *     conversationId: message.channelId,
 *     threadId: message.id,          // ← the MESSAGE id
 *
 * `threadId = message.id` gives every message in a thread a DIFFERENT thread
 * id, so nothing ever binds: channel-binding lookups miss, thread bindings are
 * never created, and each mention starts from scratch. Discord's own model is
 * the one to follow — a thread is a channel whose `parentId` is the channel it
 * was started from:
 *
 *     in a thread   → conversationId = parentId (the channel)
 *                     threadId       = channelId (the thread)
 *     in a channel  → conversationId = channelId
 *                     threadId       = undefined
 *
 * That matches how Slack has always keyed the same pair, which is what lets
 * both surfaces share the binding backend.
 *
 * THE CHANGE HAS THREE OTHER CONSUMERS, and missing any one breaks thread
 * turns in a way that looks like a model problem rather than a plumbing one:
 *
 *   1. `history.js` filtered fetched messages by `channelId === conversationId`.
 *      With `conversationId` now the PARENT, every message in the thread fails
 *      that filter and the history comes back EMPTY. It must fetch from the
 *      thread channel and drop the filter.
 *   2. `app.js` passed `conversationId: message.channelId` straight into
 *      `runAgentTurn`, so a thread turn was still recorded against the thread
 *      rather than the conversation. It must use the derived value.
 *   3. The approval-button path built its ref from `interaction.channelId` with
 *      no thread mapping at all, so a button clicked inside a thread looked up
 *      a binding under the thread id and found none.
 */

/**
 * Derive the pair from anything carrying a Discord channel.
 *
 * Takes the CHANNEL rather than the message so the button path — which has an
 * interaction, not a message — can use the same derivation. `isThread()` is
 * discord.js's own predicate; a partial or uncached channel that cannot answer
 * it falls through to the channel shape, which is the safe default (a wrong
 * "not a thread" costs a binding, a wrong "is a thread" keys against a
 * `parentId` that may not exist).
 *
 * @param {{ id?: string, isThread?: () => boolean, parentId?: string|null }} channel
 * @param {string} [fallbackChannelId] Used when `channel` is absent/partial.
 */
export function deriveConversationContext(channel, fallbackChannelId) {
	const channelId = channel?.id ?? fallbackChannelId;
	const isThread =
		typeof channel?.isThread === "function" ? channel.isThread() : false;

	if (isThread && channel?.parentId) {
		return {
			conversationId: channel.parentId,
			threadId: channelId,
			isThread: true,
		};
	}
	return { conversationId: channelId, threadId: undefined, isThread: false };
}

/**
 * The full turn ref for a message, ready to hand to `resolveTurnTarget`.
 *
 * `projectId` is the LEGACY single-project fallback and is overwritten by the
 * resolved target before the turn runs — it is only here so a deployment that
 * predates per-user linking still has something.
 */
export function buildMessageRef(message, { legacyProjectId } = {}) {
	const context = deriveConversationContext(message.channel, message.channelId);
	return {
		ref: {
			surfaceKind: "discord",
			tenantId: message.guildId,
			actorId: message.author?.id,
			projectId: legacyProjectId,
			conversationId: context.conversationId,
			...(context.threadId !== undefined ? { threadId: context.threadId } : {}),
		},
		context,
	};
}

/**
 * The same, for a button interaction.
 *
 * Deliberately shares `deriveConversationContext` with the message path: a
 * button clicked inside a thread must resolve to the SAME conversation the
 * proposal was made in, or the clicker's binding lookup misses and an approval
 * that should just work reports "not linked".
 */
export function buildInteractionRef(interaction, { legacyProjectId } = {}) {
	const context = deriveConversationContext(
		interaction.channel,
		interaction.channelId,
	);
	return {
		ref: {
			surfaceKind: "discord",
			tenantId: interaction.guildId,
			actorId: interaction.user?.id,
			projectId: legacyProjectId,
			conversationId: context.conversationId,
			...(context.threadId !== undefined ? { threadId: context.threadId } : {}),
		},
		context,
	};
}
