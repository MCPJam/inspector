// @ts-nocheck

/**
 * Derive the `(conversationId, threadId)` pair a turn resolves and binds against.
 *
 * Discord has no single "thread key", so the pair has to be built. It must
 * satisfy one property to be worth anything: a mention posted in a channel and
 * every later message in the thread started from that mention MUST derive the
 * SAME pair. Otherwise the binding written by the first turn is invisible to the
 * second, the thread re-resolves on every reply, and each turn silently runs in
 * the default project of whoever happened to speak last.
 *
 * It does hold, because a Discord thread started from a message takes that
 * message's id as its own channel id:
 *
 *   channel mention   → conversationId = channelId          threadId = message.id
 *   inside the thread → conversationId = channel.parentId   threadId = channelId
 *
 * `channel.parentId` in the second row is the channel from the first, and the
 * thread's `channelId` is the first row's `message.id` — so both rows produce
 * one key and the binding carries across the boundary. This also mirrors Slack,
 * where a top-level message's `threadTs` is its own `ts`: the id of the thread
 * that would be created if someone replied.
 *
 * The previous derivation used `message.id` for the threadId in BOTH cases, so
 * every single message minted a fresh thread key and no binding ever matched.
 */
export function deriveConversationIdentity(message) {
	const inThread = Boolean(message.channel?.isThread?.());
	// `parentId` is null when a thread's parent is gone. Falling back to the
	// thread's own id keeps the pair well-formed instead of sending `null`
	// through to the backend as a channel id.
	const conversationId = inThread
		? message.channel.parentId || message.channelId
		: message.channelId;
	const threadId = inThread ? message.channelId : message.id;
	return { inThread, conversationId, threadId };
}

/**
 * Pin a thread to the project its first turn resolved to.
 *
 * A new conversation binds to the initiator's org/project. Everything said in
 * this thread afterwards belongs to that project, whoever says it — the
 * alternative is a thread that drifts between projects and lands a suite
 * somewhere nobody expected. First writer wins server-side, so a race here
 * resolves to one binding rather than to the last writer's.
 *
 * Only `user`-mode turns bind: `legacy` runs on a shared key with no org to
 * attribute the thread to, and the other modes never reach a run.
 *
 * @returns {Promise<{ok: true, projectId?: string} | {ok: false}>}
 */
export async function ensureThreadBinding({
	backend,
	ctx,
	conversationId,
	threadId,
	target,
	logger = console,
}) {
	if (
		target.boundThread ||
		target.mode !== "user" ||
		!target.organizationId ||
		!target.projectId
	)
		return { ok: true, projectId: target.projectId };

	const binding = await backend
		.createThreadBinding({
			surfaceKind: "discord",
			surfaceTenantId: ctx.tenantId,
			channelId: conversationId,
			// `threadTs` is the wire name the backend reads for every surface — a
			// Slack-shaped field name carried into a shared route, not a timestamp.
			threadTs: threadId,
			organizationId: target.organizationId,
			projectId: target.projectId,
			initiatorSurfaceUserId: ctx.actorId,
		})
		.catch((error) => {
			logger.error(`Could not bind thread to a project: ${error}`);
			return null;
		});

	// A 200 carrying no projectId still means nothing was pinned — the backend
	// answers `{created: false, reason: 'project_not_in_org'}` in that shape — so
	// treat it exactly like a thrown error rather than like a successful bind.
	if (!binding?.projectId) return { ok: false };

	// First writer wins server-side, and the loser of a race is handed the
	// WINNER's project here. Using it is what keeps two racing turns acting in
	// the same place instead of one of them running against its own resolution.
	return { ok: true, projectId: binding.projectId };
}
