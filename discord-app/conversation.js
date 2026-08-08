// @ts-nocheck

/**
 * Derive the stable (conversationId, threadId) pair for a Discord message.
 *
 * The pair is the thread-binding KEY, so it must be identical for every
 * message in the same conversation. Discord threads are channels of their
 * own: for a message inside one, the thread channel id is the stable thread
 * identity and its parent is the conversation. For a top-level channel
 * message there is no thread yet — the message's own id becomes the root,
 * exactly like Slack keying a new thread on the root message's ts.
 *
 * Passing `message.id` unconditionally (the previous shape) keyed every
 * lookup on a fresh id, so a binding written for a thread could never be
 * found again.
 */
export function deriveConversation(message) {
	const channel = message.channel;
	const inThread =
		typeof channel?.isThread === "function" && channel.isThread();
	if (inThread)
		return {
			conversationId: channel.parentId ?? message.channelId,
			threadId: message.channelId,
			inThread: true,
		};
	return {
		conversationId: message.channelId,
		threadId: message.id,
		inThread: false,
	};
}

/**
 * Pin an unbound conversation to the initiator's org/project — or say why not.
 *
 * Mirrors slack-app/listeners/events/run-and-reply.js: a new conversation
 * binds to the initiator's project, and everything said in it afterwards
 * belongs to that project WHOEVER says it. The alternative is a thread that
 * re-resolves per speaker and drifts between projects — a silent
 * cross-project write, which is worse than a visible "try again".
 *
 * First writer wins server-side: a lost race returns the existing binding,
 * and the caller must adopt ITS projectId rather than the target's.
 *
 * Wire contract (backend surfaceRoutes.ts /agent/thread-bindings/create):
 * body needs `threadTs` and `initiatorSurfaceUserId` (those exact names);
 * the route 401s when the initiator is not linked to the claimed org, and
 * the mutation answers `{created:false, reason}` when the project is not in
 * the org — both are failures here, never a downgrade to unbound.
 *
 * @returns {Promise<{ok: true, projectId?: string} | {ok: false}>}
 */
export async function ensureThreadBinding({
	backend,
	target,
	tenantId,
	actorId,
	conversationId,
	threadId,
}) {
	const needsBinding =
		!target.boundThread &&
		target.mode === "user" &&
		Boolean(target.organizationId) &&
		Boolean(target.projectId);
	if (!needsBinding) return { ok: true, projectId: target.projectId };
	const result = await backend
		.createThreadBinding({
			surfaceKind: "discord",
			surfaceTenantId: tenantId,
			channelId: conversationId,
			threadTs: threadId,
			projectId: target.projectId,
			organizationId: target.organizationId,
			initiatorSurfaceUserId: actorId,
		})
		.catch(() => null);
	if (!result || (result.created === false && result.reason))
		return { ok: false };
	return { ok: true, projectId: result.projectId || target.projectId };
}
