// @ts-nocheck
const REQUEST_TIMEOUT_MS = 10_000;

export class InstallationBackendError extends Error {
	/** @param {string} message @param {{status?:number,code?:string}} [opts] */
	constructor(message, opts = {}) {
		super(message);
		this.name = "InstallationBackendError";
		this.status = opts.status;
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
	const fetchDefault = options.fetchImpl || fetch;
	async function post(path, body, opts = {}) {
		const origin = baseUrl();
		const serviceToken = token();
		if (!origin || !serviceToken)
			throw new InstallationBackendError(
				"Backend service configuration is missing.",
				{ code: "CONFIG" },
			);
		const fetchImpl = opts.fetchImpl || fetchDefault;
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
	const actorBody = (ctx) => ({
		surfaceKind: options.surfaceKind,
		surfaceTenantId: ctx.tenantId,
		surfaceUserId: ctx.actorId,
	});
	return {
		post,
		fetchThreadBinding: async (ctx, conversationId, threadId, opts) =>
			(
				await post(
					`${prefix}/thread-bindings/get`,
					{ ...actorBody(ctx), channelId: conversationId, threadTs: threadId },
					opts,
				)
			)?.binding ?? null,
		createThreadBinding: (args, opts) =>
			post(`${prefix}/thread-bindings/create`, args, opts),
		fetchAccountLink: async (ctx, opts) =>
			(await post(`${prefix}/links/fetch`, actorBody(ctx), opts))?.link ?? null,
		revokeAccountLink: (ctx, opts) =>
			post(`${prefix}/links/revoke`, actorBody(ctx), opts),
		claimEvent: async (dedupeKey, opts) => {
			const payload = await post(`${prefix}/claims/claim`, { dedupeKey }, opts);
			if (!["claimed", "inflight", "completed"].includes(payload?.outcome))
				throw new InstallationBackendError("Unknown claim outcome");
			return {
				outcome: payload.outcome,
				resultEnvelope: payload.resultEnvelope ?? null,
			};
		},
		completeEvent: (dedupeKey, resultEnvelope, opts) =>
			post(`${prefix}/claims/complete`, { dedupeKey, resultEnvelope }, opts),
		releaseEvent: (dedupeKey, opts) =>
			post(`${prefix}/claims/release`, { dedupeKey }, opts),
		mintLink: async (ctx, opts) =>
			(await post("/api/surface-link/session", actorBody(ctx), opts))?.url,
		fetchProposedAction: async (actionId, opts) =>
			(await post(`${prefix}/proposed-actions/get`, { actionId }, opts))
				?.action ?? null,
	};
}
