/** @typedef {{mode:'user'|'legacy'|'needs_project'|'unlinked',projectId?:string,organizationId?:string,initiatorActorId?:string,boundThread?:boolean}} TurnTarget */

/** @param {{backend:any,surfaceKind:string,hasPerUserAuth?:()=>boolean,legacyProjectId?:()=>string|undefined}} options */
export function createTurnTargetResolver(options) {
	const hasAuth = options.hasPerUserAuth || (() => true);
	const legacyProjectId =
		options.legacyProjectId || (() => process.env.MCPJAM_PROJECT_ID);
	/** @param {any} ctx @param {{conversationId?:string,threadId?:string,fetchImpl?:typeof fetch}} [args] */
	return async function resolveTurnTarget(ctx, args = {}) {
		const { conversationId, threadId, fetchImpl } = args;
		if (!hasAuth())
			return ctx.isLegacyTenant === true
				? { mode: "legacy", projectId: legacyProjectId() }
				: { mode: "unlinked" };
		const binding =
			conversationId && threadId
				? await options.backend.fetchThreadBinding(
						ctx,
						conversationId,
						threadId,
						{ fetchImpl },
					)
				: null;
		if (binding)
			return {
				mode: "user",
				projectId: binding.projectId,
				organizationId: binding.organizationId,
				initiatorActorId:
					binding.initiatorActorId || binding.initiatorSlackUserId,
				boundThread: true,
			};
		const link = await options.backend.fetchAccountLink(ctx, { fetchImpl });
		if (link)
			return link.defaultProjectId
				? {
						mode: "user",
						projectId: link.defaultProjectId,
						organizationId: link.organizationId,
					}
				: { mode: "needs_project", organizationId: link.organizationId };
		return ctx.isLegacyTenant === true && legacyProjectId()
			? { mode: "legacy", projectId: legacyProjectId() }
			: { mode: "unlinked" };
	};
}
