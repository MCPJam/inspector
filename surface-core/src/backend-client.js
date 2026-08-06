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
	const token = () =>
		options.serviceToken ||
		(options.serviceTokenEnv
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
		/** @param {Record<string, unknown>} args @param {CallOptions} [opts] */
		createThreadBinding: (args, opts) =>
			post(`${prefix}/thread-bindings/create`, args, opts),
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
