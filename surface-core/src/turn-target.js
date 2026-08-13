/**
 * Which project a turn acts in, and as whom.
 *
 * The precedence is a product decision, and it is the same on every surface:
 *
 *   thread binding → channel binding → the speaker's default → the org's
 *   default → legacy tenant → unlinked
 *
 * @typedef {Object} TurnTarget
 * @property {'user'|'legacy'|'needs_project'|'unlinked'} mode
 * @property {string} [projectId]
 * @property {string} [organizationId]
 * @property {string} [initiatorActorId]
 * @property {boolean} [boundThread]   True when a THREAD binding decided this.
 * @property {boolean} [boundChannel]  True when a CHANNEL binding decided this.
 * @property {boolean} [orgDefault]    True when the ORG's default decided this.
 */

/**
 * @param {{
 *   backend: any,
 *   surfaceKind: string,
 *   hasPerUserAuth?: () => boolean,
 *   legacyProjectId?: () => string | undefined,
 *   channelBindingCache?: import('./channel-binding-cache.js').ChannelBindingCache,
 * }} options
 */
export function createTurnTargetResolver(options) {
	const hasAuth = options.hasPerUserAuth || (() => true);
	const legacyProjectId =
		options.legacyProjectId || (() => process.env.MCPJAM_PROJECT_ID);
	// Channel bindings are written by an admin through a separate settings
	// flow, never by the turn that reads one — so unlike a thread binding,
	// there is no same-request write-then-stale-read race, and caching (INCLUDING
	// negatives, the common case: most channels have none) is safe. Optional:
	// a caller that supplies no cache gets the prior uncached behavior exactly.
	const channelBindingCache = options.channelBindingCache;
	/** @param {any} ctx @param {string} conversationId @param {{fetchImpl?: typeof fetch}} opts */
	const fetchChannelBinding = (ctx, conversationId, opts) => {
		const read = () =>
			options.backend.fetchChannelBinding(ctx, conversationId, opts);
		if (!channelBindingCache) return read();
		const key = `${options.surfaceKind}:${ctx.tenantId}:${conversationId}`;
		const cached = channelBindingCache.get(key);
		return cached !== undefined
			? Promise.resolve(cached)
			: channelBindingCache.coalesce(key, read);
	};

	/**
	 * @param {any} ctx
	 * @param {{conversationId?: string, threadId?: string, fetchImpl?: typeof fetch}} [args]
	 * @returns {Promise<TurnTarget>}
	 */
	return async function resolveTurnTarget(ctx, args = {}) {
		const { conversationId, threadId, fetchImpl } = args;
		const opts = { fetchImpl };

		// No per-user auth configured at all. Note the deliberate asymmetry with
		// the legacy fallback at the bottom, which additionally requires a
		// project id: THERE, per-user auth exists, so falling through to
		// `unlinked` gives the user a connect button they can actually use. HERE
		// it does not, so `unlinked` would show a connect flow that cannot
		// complete. Returning `legacy` with no project surfaces the credential
		// seam's config error instead, which names the missing variable and is
		// aimed at the operator who can fix it.
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
						opts,
					)
				: null;
		// A bound thread does not re-resolve. The replier still has to be linked
		// and still has to have access to the bound project — but that is
		// enforced server-side (the delegated mint re-verifies membership), not
		// by silently choosing a different project for them.
		if (binding)
			return {
				mode: "user",
				projectId: binding.projectId,
				organizationId: binding.organizationId,
				initiatorActorId:
					binding.initiatorActorId || binding.initiatorSlackUserId,
				boundThread: true,
			};

		// The channel binding and the speaker's link are fetched TOGETHER,
		// because the answer needs both and neither depends on the other.
		// Sequentially this would put a second round trip on the hot path of
		// exactly the channels an org configured to be frictionless.
		const [channelBinding, link] = await Promise.all([
			conversationId && options.backend.fetchChannelBinding
				? fetchChannelBinding(ctx, conversationId, opts)
				: Promise.resolve(null),
			options.backend.fetchAccountLink(ctx, opts),
		]);

		// An org admin bound this channel to a project. Below the thread binding
		// (an engaged thread is not moved) and above the speaker's own default
		// (the binding is a statement about this PLACE, and its whole value is
		// that nobody has to configure anything to use the channel).
		//
		// GATED ON BEING LINKED, unlike the thread binding above. A bound channel
		// is often where someone speaks to the bot for the FIRST time, and
		// running an unlinked person as `user` sends them to an inevitable 401
		// whose reply is a sentence; falling through to `unlinked` gives them the
		// connect BUTTON. The thread binding can short-circuit because its
		// initiator already resolved, whereas anyone at all can be the first to
		// post in a bound channel.
		//
		// The org comparison is load-bearing wherever one workspace hosts more
		// than one org: without it a binding written by org A would decide a
		// turn for a member of org B.
		if (
			link &&
			channelBinding &&
			channelBinding.organizationId === link.organizationId
		)
			return {
				mode: "user",
				projectId: channelBinding.projectId,
				organizationId: channelBinding.organizationId,
				boundChannel: true,
			};

		if (link) {
			// The ORG's default is the fallback for someone who never picked, so
			// it is consulted only when the user's own default is absent — never
			// as an override. `orgDefaultProjectId` is absent entirely on a
			// backend that predates the field, which reads the same as "none set".
			if (link.defaultProjectId)
				return {
					mode: "user",
					projectId: link.defaultProjectId,
					organizationId: link.organizationId,
				};
			if (link.orgDefaultProjectId)
				return {
					mode: "user",
					projectId: link.orgDefaultProjectId,
					organizationId: link.organizationId,
					orgDefault: true,
				};
			return { mode: "needs_project", organizationId: link.organizationId };
		}

		// Unlinked. A legacy tenant still works on the shared key so the first
		// workspace is not locked out mid-migration; everyone else connects.
		return ctx.isLegacyTenant === true && legacyProjectId()
			? { mode: "legacy", projectId: legacyProjectId() }
			: { mode: "unlinked" };
	};
}
