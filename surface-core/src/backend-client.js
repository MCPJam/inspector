const REQUEST_TIMEOUT_MS = 10_000;

/** @typedef {{ tenantId: string, actorId: string }} SurfaceActor */
/** @typedef {{ fetchImpl?: typeof fetch, timeoutMs?: number }} CallOptions */

export class InstallationBackendError extends Error {
	/** @param {string} message @param {{status?:number,code?:string}} [opts] */
	constructor(message, opts = {}) {
		super(message);
		this.name = "InstallationBackendError";
		/** @type {number | undefined} */
		this.status = opts.status;
		/** @type {string | undefined} */
		this.code = opts.code;
	}
}

/**
 * Surface-scoped service-token client. It never accepts a bare surface token
 * as a bearer user credential and every route family is injected explicitly.
 * @param {{surfaceKind:string, baseUrl?:string, serviceToken?:string, serviceTokenEnv?:string, authHeaderName?:string, routePrefix?:string, fetchImpl?:typeof fetch}} options
 */
export function createBackendClient(options) {
	const baseUrl = () =>
		String(options.baseUrl || process.env.MCPJAM_CONVEX_HTTP_URL || "").replace(
			/\/+$/,
			"",
		);
	/**
	 * The credential, and WHO decides it.
	 *
	 * An explicit `serviceToken` key is AUTHORITATIVE, including when its value
	 * is undefined. That distinction is the whole point: a caller that keeps a
	 * config snapshot (Discord does) trims its env vars, so a token set to
	 * whitespace is `undefined` in the snapshot — and the env fallbacks below
	 * would then quietly reinstate the raw whitespace string, which is truthy.
	 * The config would report the service as unconfigured while this client
	 * kept sending a blank credential, turning a documented no-op into a 401 on
	 * every call. `in` rather than a truthiness test is what tells "the caller
	 * has an opinion and it is none" from "the caller never said".
	 */
	const hasExplicitToken = "serviceToken" in options;
	const token = () =>
		hasExplicitToken
			? options.serviceToken
			: (options.serviceTokenEnv
					? process.env[options.serviceTokenEnv]
					: undefined) ||
				process.env[`${options.surfaceKind.toUpperCase()}_SERVICE_TOKEN`];
	const header =
		options.authHeaderName || `x-${options.surfaceKind}-service-token`;
	// Resolved per CALL — see the note in api-client.js. Capturing `fetch` at
	// construction pins module-load time and ignores anything installed later.
	/** @param {typeof fetch | undefined} perCall */
	const resolveFetch = (perCall) => perCall || options.fetchImpl || fetch;
	/**
	 * @param {string} path
	 * @param {Record<string, unknown>} body
	 * @param {CallOptions} [opts]
	 * @returns {Promise<any>}
	 */
	async function post(path, body, opts = {}) {
		const origin = baseUrl();
		const serviceToken = token();
		if (!origin || !serviceToken)
			throw new InstallationBackendError(
				"Backend service configuration is missing.",
				{ code: "CONFIG" },
			);
		const fetchImpl = resolveFetch(opts.fetchImpl);
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(),
			opts.timeoutMs || REQUEST_TIMEOUT_MS,
		);
		try {
			const response = await fetchImpl(`${origin}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", [header]: serviceToken },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch (error) {
				if (!(error instanceof SyntaxError)) throw error;
			}
			if (!response.ok)
				throw new InstallationBackendError(
					payload?.error ||
						payload?.message ||
						`Backend error (${response.status})`,
					{ status: response.status, code: payload?.code },
				);
			return payload;
		} catch (error) {
			if (error instanceof InstallationBackendError) throw error;
			const aborted = error instanceof Error && error.name === "AbortError";
			throw new InstallationBackendError(
				aborted
					? "Backend request timed out"
					: `Backend request failed: ${error}`,
				{ code: aborted ? "TIMEOUT" : "NETWORK" },
			);
		} finally {
			clearTimeout(timer);
		}
	}
	const prefix = options.routePrefix || `/${options.surfaceKind}`;
	/** @param {SurfaceActor} ctx */
	const actorBody = (ctx) => ({
		surfaceKind: options.surfaceKind,
		surfaceTenantId: ctx.tenantId,
		surfaceUserId: ctx.actorId,
	});
	return {
		post,
		/**
		 * @param {SurfaceActor} ctx
		 * @param {string} conversationId
		 * @param {string} threadId
		 * @param {CallOptions} [opts]
		 */
		fetchThreadBinding: async (ctx, conversationId, threadId, opts) =>
			(
				await post(
					`${prefix}/thread-bindings/get`,
					{ ...actorBody(ctx), channelId: conversationId, threadTs: threadId },
					opts,
				)
			)?.binding ?? null,
		/**
		 * Bind a thread to a project, using the SAME body vocabulary the get
		 * path above sends.
		 *
		 * This used to take a raw `args` object and forward it verbatim, which
		 * put the burden of knowing the wire names on every caller — and the
		 * names are not guessable: the backend wants `surfaceTenantId`,
		 * `surfaceUserId`-style actor fields and calls the thread `threadTs`
		 * (Slack's word, kept when the route was generalized), while a surface
		 * naturally has `tenantId`, `actorId` and `threadId`. A caller that
		 * passed its own spelling got a 400 on every write, so the binding was
		 * simply never created and threads silently stayed unbound — the same
		 * failure whether the backend was down or the payload was wrong.
		 *
		 * Taking the same `(ctx, conversationId, threadId)` triple as
		 * `fetchThreadBinding` makes read and write symmetrical by construction:
		 * whatever identifies a binding to look up now identifies the one being
		 * created.
		 *
		 * @param {SurfaceActor} ctx
		 * @param {string} conversationId
		 * @param {string} threadId
		 * @param {{ projectId: string, organizationId: string }} binding
		 * @param {CallOptions} [opts]
		 */
		createThreadBinding: (ctx, conversationId, threadId, binding, opts) =>
			post(
				`${prefix}/thread-bindings/create`,
				{
					...actorBody(ctx),
					channelId: conversationId,
					threadTs: threadId,
					projectId: binding.projectId,
					organizationId: binding.organizationId,
					// The backend resolves this to an account link and REJECTS the
					// write if the link's org is not the one above — the check that
					// stops a thread being bound to an org the initiator is not in.
					initiatorSurfaceUserId: ctx.actorId,
				},
				opts,
			),
		/**
		 * An org admin's channel→project binding, or null.
		 *
		 * A backend that predates the route answers 404/405, which reads the same
		 * as "no binding" — the alternative is a bot that cannot resolve a turn
		 * at all until the backend catches up. Any other failure still throws:
		 * "we could not ask" must not become "there is none".
		 *
		 * @param {SurfaceActor} ctx
		 * @param {string} conversationId
		 * @param {CallOptions} [opts]
		 * @returns {Promise<any | null>}
		 */
		fetchChannelBinding: async (ctx, conversationId, opts) => {
			try {
				const payload = await post(
					`${prefix}/channel-bindings/get`,
					{ ...actorBody(ctx), channelId: conversationId },
					opts,
				);
				return payload?.binding ?? null;
			} catch (error) {
				if (
					error instanceof InstallationBackendError &&
					(error.status === 404 || error.status === 405)
				)
					return null;
				throw error;
			}
		},
		/** @param {SurfaceActor} ctx @param {CallOptions} [opts] */
		fetchAccountLink: async (ctx, opts) =>
			(await post(`${prefix}/links/fetch`, actorBody(ctx), opts))?.link ?? null,
		/** @param {SurfaceActor} ctx @param {CallOptions} [opts] */
		revokeAccountLink: (ctx, opts) =>
			post(`${prefix}/links/revoke`, actorBody(ctx), opts),
		/** @param {string} dedupeKey @param {CallOptions} [opts] */
		claimEvent: async (dedupeKey, opts) => {
			const payload = await post(`${prefix}/claims/claim`, { dedupeKey }, opts);
			if (!["claimed", "inflight", "completed"].includes(payload?.outcome))
				throw new InstallationBackendError("Unknown claim outcome");
			return {
				outcome: payload.outcome,
				resultEnvelope: payload.resultEnvelope ?? null,
			};
		},
		/** @param {string} dedupeKey @param {unknown} resultEnvelope @param {CallOptions} [opts] */
		completeEvent: (dedupeKey, resultEnvelope, opts) =>
			post(`${prefix}/claims/complete`, { dedupeKey, resultEnvelope }, opts),
		/** @param {string} dedupeKey @param {CallOptions} [opts] */
		releaseEvent: (dedupeKey, opts) =>
			post(`${prefix}/claims/release`, { dedupeKey }, opts),
		/** @param {SurfaceActor} ctx @param {CallOptions} [opts] */
		mintLink: async (ctx, opts) =>
			(await post("/api/surface-link/session", actorBody(ctx), opts))?.url,
		/** @param {string} actionId @param {CallOptions} [opts] */
		fetchProposedAction: async (actionId, opts) =>
			(await post(`${prefix}/proposed-actions/get`, { actionId }, opts))
				?.action ?? null,
	};
}
