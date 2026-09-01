const DEFAULT_BASE_URL = "https://app.mcpjam.com";
const TURN_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 30_000;
const EXECUTE_ACTION_TIMEOUT_MS = 150_000;

/** @typedef {{ role: 'user'|'assistant', content: string }} TurnMessage */
/** @typedef {{ actionId:string, operation:string, description:string }} ProposedAction */
/** @typedef {Record<string, any>} SurfaceContext the caller's tenancy, shaped by its own adapter */
/** @typedef {{ apiKey: string, projectId: string, baseUrl: string, appUrl: string, headers: Record<string,string>, routePrefix?: string }} ResolvedConfig */
/**
 * @typedef {Object} RequestOptions
 * @property {typeof fetch} [fetchImpl]
 * @property {string} [idempotencyKey]
 * @property {string} [conversationId]
 * @property {string} [channelId]
 * @property {number} [limit]
 * @property {string} [projectId]
 * @property {string} [apiKey]
 * @property {string} [baseUrl]
 * @property {string} [appUrl]
 */

export class McpjamApiError extends Error {
	/** @param {string} message @param {{code?:string,status?:number,details?:Record<string,any>}} [opts] */
	constructor(message, opts = {}) {
		super(message);
		this.name = "McpjamApiError";
		/** @type {string | undefined} */
		this.code = opts.code;
		/** @type {number | undefined} */
		this.status = opts.status;
		/** @type {Record<string, any> | undefined} */
		this.details = opts.details;
	}

	/** @returns {import('./copy.js').StructuredContent} */
	get structuredContent() {
		/** @type {Record<string, string>} */
		const messages = {
			RATE_LIMITED:
				"I am at capacity right now — give it a minute and try again.",
			TIMEOUT:
				"That took longer than I allow for one reply. Try breaking the request into smaller steps.",
			SERVER_UNREACHABLE:
				"I can't reach MCPJam right now. Try again in a moment.",
			UNAUTHORIZED:
				"I need you to connect your MCPJam account before I can do that.",
			FORBIDDEN:
				"You don't have access to the project this thread is working in.",
		};
		return {
			severity: "error",
			code: this.code,
			parts: [
				(this.code ? messages[this.code] : undefined) ||
					"Something went wrong talking to MCPJam. Try again in a moment.",
			],
		};
	}

	get friendlyMessage() {
		return this.structuredContent.parts[0];
	}
}

/** @param {string} value */
function trimOrigin(value) {
	return String(value || "").replace(/\/+$/, "");
}

/**
 * The app URL for one eval run, matching what `@mcpjam/sdk/platform`'s
 * `buildAppPermalink` mints for `eval_run`.
 *
 * MIRRORED, NOT IMPORTED — the same trade `run-evidence.js` documents:
 * surface-core has zero dependencies on purpose so a bot can vendor it. The
 * `?project=` is the load-bearing part: eval routes carry no project segment,
 * so without it the link opens whichever project the reader last selected.
 *
 * @param {{ appUrl: string, projectId: string }} config
 * @param {string} suiteId
 * @param {string} runId
 */
function runUrlFor(config, suiteId, runId) {
	const url = new URL(
		`/evals/suite/${encodeURIComponent(suiteId)}/runs/${encodeURIComponent(runId)}`,
		config.appUrl,
	);
	url.searchParams.set("project", config.projectId);
	return url.toString();
}

/**
 * Create the API client for one surface. The transport knows only the
 * injected wire config; rendering and platform names never enter this file.
 * @param {{surfaceKind?:string, routePrefix?:string, conversationField?:string, authHeaderName?:string, identityHeaders?:(ctx:any)=>Record<string,string>, getConfig?:(ctx:any,overrides?:any)=>any, baseUrl?:string, fetchImpl?:typeof fetch}} [options]
 */
export function createApiClient(options = {}) {
	const routePrefix = options.routePrefix ?? "/agent";
	const conversationField = options.conversationField ?? "conversationId";
	const identityHeaders =
		options.identityHeaders ??
		((/** @type {SurfaceContext} */ ctx) => ({
			"x-mcpjam-surface-tenant-id": String(ctx.tenantId),
			"x-mcpjam-surface-actor-id": String(ctx.actorId),
		}));
	// Resolved per CALL, never captured here. Snapshotting `fetch` at
	// construction silently pins whatever was installed at module load, so any
	// later instrumentation — a test's stub, an agent-injecting proxy — is
	// ignored by a client that was created first.
	/** @param {typeof fetch | undefined} perCall */
	const resolveFetch = (perCall) => perCall ?? options.fetchImpl ?? fetch;

	/**
	 * @param {SurfaceContext} ctx
	 * @param {RequestOptions} [overrides]
	 * @returns {ResolvedConfig}
	 */
	function getConfig(ctx, overrides = {}) {
		if (options.getConfig) return options.getConfig(ctx, overrides);
		if (!ctx?.tenantId || !ctx?.actorId)
			throw new McpjamApiError(
				"MCPJam credentials require a tenant and actor.",
				{ code: "CONFIG" },
			);
		const baseUrl = trimOrigin(
			overrides.baseUrl ||
				options.baseUrl ||
				process.env.MCPJAM_BASE_URL ||
				DEFAULT_BASE_URL,
		);
		const appUrl = trimOrigin(
			overrides.appUrl || process.env.MCPJAM_APP_URL || baseUrl,
		);
		const projectId = overrides.projectId || ctx.projectId;
		const apiKey =
			overrides.apiKey ||
			process.env.MCPJAM_SURFACE_API_KEY ||
			process.env.MCPJAM_API_KEY;
		if (!apiKey || !projectId)
			throw new McpjamApiError(
				"MCPJam API credentials and a project are required.",
				{ code: !apiKey ? "CONFIG" : "NO_PROJECT" },
			);
		return {
			apiKey,
			projectId,
			baseUrl,
			appUrl,
			headers: identityHeaders(ctx),
			routePrefix,
		};
	}

	/** @param {string} url @param {{method?:string,body?:any,apiKey:string,timeoutMs:number,fetchImpl?:typeof fetch,idempotencyKey?:string,headers?:Record<string,string>}} input */
	async function requestJson(
		url,
		{
			method = "GET",
			body,
			apiKey,
			timeoutMs,
			fetchImpl,
			idempotencyKey,
			headers = {},
		},
	) {
		const doFetch = resolveFetch(fetchImpl);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await doFetch(url, {
				method,
				headers: {
					Authorization: `Bearer ${apiKey}`,
					...(body ? { "Content-Type": "application/json" } : {}),
					...(idempotencyKey
						? { "x-mcpjam-idempotency-key": idempotencyKey }
						: {}),
					...headers,
				},
				...(body ? { body: JSON.stringify(body) } : {}),
				signal: controller.signal,
			});
			let payload = null;
			try {
				payload = await response.json();
			} catch (error) {
				// A body that isn't JSON (an HTML error page, an empty 204) is fine —
				// `payload` stays null and the status decides. Anything else is a real
				// failure mid-body and MUST NOT be laundered into "no body": headers
				// already arrived, so `response.ok` is true and a stalled stream would
				// be reported as an empty, successful reply.
				if (!(error instanceof SyntaxError)) throw error;
			}
			if (!response.ok)
				throw new McpjamApiError(
					payload?.message || `MCPJam API error (${response.status})`,
					{
						code: payload?.code,
						status: response.status,
						// A FAILED turn may still have persisted resources or proposals
						// in `details`; discarding them is how a caller comes to believe
						// "failed" means "nothing happened". Only accept an object.
						...(payload?.details && typeof payload.details === "object"
							? { details: payload.details }
							: {}),
					},
				);
			return payload;
		} catch (error) {
			if (error instanceof McpjamApiError) throw error;
			const aborted = error instanceof Error && error.name === "AbortError";
			throw new McpjamApiError(
				aborted
					? `Request timed out after ${timeoutMs}ms`
					: `Request failed: ${error}`,
				{ code: aborted ? "TIMEOUT" : "NETWORK" },
			);
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * @param {TurnMessage[]} messages
	 * @param {SurfaceContext} ctx
	 * @param {RequestOptions} [opts]
	 */
	async function runAgentTurn(messages, ctx, opts = {}) {
		const config = getConfig(ctx, opts);
		const payload = await requestJson(
			`${config.baseUrl}/api/v1/projects/${encodeURIComponent(config.projectId)}${routePrefix}`,
			{
				method: "POST",
				body: {
					messages,
					...(opts.idempotencyKey
						? { idempotencyKey: opts.idempotencyKey }
						: {}),
					...(opts.conversationId || opts.channelId
						? { [conversationField]: opts.conversationId || opts.channelId }
						: {}),
				},
				apiKey: config.apiKey,
				headers: config.headers,
				timeoutMs: TURN_TIMEOUT_MS,
				fetchImpl: opts.fetchImpl,
			},
		);
		return {
			reply: typeof payload?.reply === "string" ? payload.reply : "",
			toolCalls: Array.isArray(payload?.toolCalls) ? payload.toolCalls : [],
			createdResources: Array.isArray(payload?.createdResources)
				? payload.createdResources
				: [],
			proposedActions: Array.isArray(payload?.proposedActions)
				? payload.proposedActions
				: [],
		};
	}

	/**
	 * @param {string} actionId
	 * @param {SurfaceContext} ctx
	 * @param {RequestOptions} [opts]
	 */
	async function executeProposedAction(actionId, ctx, opts = {}) {
		const config = getConfig(ctx, opts);
		const payload = await requestJson(
			`${config.baseUrl}/api/v1/projects/${encodeURIComponent(config.projectId)}/proposed-actions/${encodeURIComponent(actionId)}/execute`,
			{
				method: "POST",
				apiKey: config.apiKey,
				headers: config.headers,
				timeoutMs: EXECUTE_ACTION_TIMEOUT_MS,
				fetchImpl: opts.fetchImpl,
			},
		);
		const result = payload?.result ?? null;
		// The SERVER builds the link, from the operation registry that knows each
		// result's shape. Prefer it, and keep the type/id alongside: a caller
		// decides whether to watch a run by the resource TYPE the server sent,
		// never by guessing from an operation name it may not recognise.
		//
		// NON-EMPTY, not merely a string: an empty url is not a link, and
		// letting one through would hand a caller `runUrl: ''` to render.
		const resource =
			payload?.resource &&
			typeof payload.resource.url === "string" &&
			payload.resource.url !== ""
				? {
						type: String(payload.resource.type ?? ""),
						id: String(payload.resource.id ?? ""),
						url: String(payload.resource.url),
					}
				: null;
		// The run's own ids still travel — a caller decides whether to WATCH a
		// run from these — but no URL is synthesised from them any more. The
		// server derives every executed action's link from the operation
		// catalog's permalink policy, so `resource.url` is now present for
		// anything linkable; a synthesised twin would only differ from it when
		// one of them was wrong, and this one could not know the project scope
		// the operation actually resolved.
		const runId = typeof result?.runId === "string" ? result.runId : null;
		const suiteId =
			typeof result?.suiteId === "string"
				? result.suiteId
				: typeof result?.suite?.id === "string"
					? result.suite.id
					: null;
		return {
			runId,
			suiteId,
			status:
				typeof payload?.status === "string" ? payload.status : "succeeded",
			operation:
				typeof payload?.operation === "string" ? payload.operation : "",
			// `kind` is what lets a surface word the confirmation truthfully for an
			// operation this build has never heard of. Dropping it forces every
			// renderer back onto an operation-name table that ages badly.
			kind: typeof payload?.kind === "string" ? payload.kind : null,
			resource,
			result,
			runUrl: resource?.url ?? null,
		};
	}

	/**
	 * @param {string} suiteId
	 * @param {SurfaceContext} ctx
	 * @param {RequestOptions} [opts]
	 */
	async function startSuiteRun(suiteId, ctx, opts = {}) {
		const config = getConfig(ctx, opts);
		const payload = await requestJson(
			`${config.baseUrl}/api/v1/projects/${encodeURIComponent(config.projectId)}/eval-runs`,
			{
				method: "POST",
				body: { suiteId },
				apiKey: config.apiKey,
				headers: config.headers,
				timeoutMs: RUN_TIMEOUT_MS,
				fetchImpl: opts.fetchImpl,
				idempotencyKey: opts.idempotencyKey,
			},
		);
		const runId = String(payload?.runId ?? "");
		if (!runId)
			throw new McpjamApiError("MCPJam started a run but returned no run id.", {
				code: "INTERNAL_ERROR",
			});
		return {
			runId,
			suiteId,
			// Built through `URL`, not concatenation, so segments stay encoded and
			// the project scope cannot be dropped. Unlike `executeAction` above
			// this route is plain REST (`POST /eval-runs`) and mints no permalink
			// of its own yet; when it does, this reads it instead. surface-core
			// deliberately depends on nothing, so it cannot call the SDK builder
			// — the shape it produces is pinned by the test below.
			url: runUrlFor(config, suiteId, runId),
		};
	}

	/**
	 * @param {string} runId
	 * @param {SurfaceContext} ctx
	 * @param {RequestOptions} [opts]
	 * @returns {Promise<any>}
	 */
	async function getEvalRun(runId, ctx, opts = {}) {
		const config = getConfig(ctx, opts);
		return requestJson(
			`${config.baseUrl}/api/v1/projects/${encodeURIComponent(config.projectId)}/eval-runs/${encodeURIComponent(runId)}`,
			{
				apiKey: config.apiKey,
				headers: config.headers,
				timeoutMs: RUN_TIMEOUT_MS,
				fetchImpl: opts.fetchImpl,
			},
		);
	}

	/**
	 * THE FIRST THING TO READ ABOUT A FINISHED RUN: what it decided, the
	 * population that decision covers, and one page of per-trial diagnostics
	 * carrying the user-value chain and the first failed stage.
	 *
	 * Separate from {@link getEvalRun} rather than folded into it because the
	 * poll loop runs every ten seconds and this document is only worth a request
	 * ONCE, when a run lands on a terminal status that is not a clean pass.
	 *
	 * NO LIMIT IS SENT by default, and that is deliberate: `limit` bounds the
	 * ITERATIONS SCANNED, not the diagnostics returned, so asking for one would
	 * scan a single iteration and report an empty failure list for every run
	 * whose first trial happened to pass.
	 *
	 * Callers must treat any error as "no chain to tell" — a deployment that
	 * predates this route answers 404, which is a fact about the deployment and
	 * never a fact about the run.
	 *
	 * @param {string} runId
	 * @param {SurfaceContext} ctx
	 * @param {RequestOptions} [opts]
	 * @returns {Promise<any>}
	 */
	async function getEvalRunDecisionSummary(runId, ctx, opts = {}) {
		const config = getConfig(ctx, opts);
		const query = opts.limit
			? `?limit=${encodeURIComponent(String(opts.limit))}`
			: "";
		return requestJson(
			`${config.baseUrl}/api/v1/projects/${encodeURIComponent(config.projectId)}/eval-runs/${encodeURIComponent(runId)}/decision-summary${query}`,
			{
				apiKey: config.apiKey,
				headers: config.headers,
				timeoutMs: RUN_TIMEOUT_MS,
				fetchImpl: opts.fetchImpl,
			},
		);
	}

	/**
	 * @param {string} runId
	 * @param {SurfaceContext} ctx
	 * @param {RequestOptions} [opts]
	 * @returns {Promise<Array<Record<string, any>>>}
	 */
	async function listEvalRunIterations(runId, ctx, opts = {}) {
		const config = getConfig(ctx, opts);
		const query = opts.limit
			? `?limit=${encodeURIComponent(String(opts.limit))}`
			: "";
		const payload = await requestJson(
			`${config.baseUrl}/api/v1/projects/${encodeURIComponent(config.projectId)}/eval-runs/${encodeURIComponent(runId)}/iterations${query}`,
			{
				apiKey: config.apiKey,
				headers: config.headers,
				timeoutMs: RUN_TIMEOUT_MS,
				fetchImpl: opts.fetchImpl,
			},
		);
		return Array.isArray(payload?.items) ? payload.items : [];
	}

	/**
	 * @param {string} runId
	 * @param {string} iterationId
	 * @param {SurfaceContext} ctx
	 * @param {RequestOptions} [opts]
	 * @returns {Promise<Array<Record<string, any>>>}
	 */
	async function getEvalRunSteps(runId, iterationId, ctx, opts = {}) {
		const config = getConfig(ctx, opts);
		const payload = await requestJson(
			`${config.baseUrl}/api/v1/projects/${encodeURIComponent(config.projectId)}/eval-runs/${encodeURIComponent(runId)}/iterations/${encodeURIComponent(iterationId)}/steps`,
			{
				apiKey: config.apiKey,
				headers: config.headers,
				timeoutMs: RUN_TIMEOUT_MS,
				fetchImpl: opts.fetchImpl,
			},
		);
		return Array.isArray(payload?.items) ? payload.items : [];
	}

	/**
	 * One journey run (the Swarms product).
	 *
	 * Deliberately NOT folded into `getEvalRun`. The two share a shape at a
	 * glance and disagree on everything that matters: a journey run's status
	 * vocabulary is completed/partial/failed/rate_limited, a deliberate stop
	 * arrives as `canceled: true` rather than a status, and a run that
	 * "completed" can still have had most of its sessions fail. A watcher that
	 * treated them as one type would report a rate-limited fan-out as a pass.
	 *
	 * @param {string} runId
	 * @param {SurfaceContext} ctx
	 * @param {RequestOptions} [opts]
	 * @returns {Promise<any>}
	 */
	async function getJourneyRun(runId, ctx, opts = {}) {
		const config = getConfig(ctx, opts);
		return requestJson(
			`${config.baseUrl}/api/v1/projects/${encodeURIComponent(config.projectId)}/journey-runs/${encodeURIComponent(runId)}`,
			{
				apiKey: config.apiKey,
				headers: config.headers,
				timeoutMs: RUN_TIMEOUT_MS,
				fetchImpl: opts.fetchImpl,
			},
		);
	}

	/**
	 * The sessions a journey run produced — one per persona attempt against
	 * each target. This is a journey run's equivalent of eval ITERATIONS, and
	 * the rename is the point: a session is a conversation, not a repeat of the
	 * same case.
	 *
	 * @param {string} runId
	 * @param {SurfaceContext} ctx
	 * @param {RequestOptions} [opts]
	 * @returns {Promise<Array<Record<string, any>>>}
	 */
	async function listJourneyRunSessions(runId, ctx, opts = {}) {
		const config = getConfig(ctx, opts);
		const query = opts.limit
			? `?limit=${encodeURIComponent(String(opts.limit))}`
			: "";
		const payload = await requestJson(
			`${config.baseUrl}/api/v1/projects/${encodeURIComponent(config.projectId)}/journey-runs/${encodeURIComponent(runId)}/sessions${query}`,
			{
				apiKey: config.apiKey,
				headers: config.headers,
				timeoutMs: RUN_TIMEOUT_MS,
				fetchImpl: opts.fetchImpl,
			},
		);
		return Array.isArray(payload?.items) ? payload.items : [];
	}

	/**
	 * A journey run's deterministic rubric scorecard.
	 *
	 * The first thing to reach for when explaining a failure: no model is
	 * involved, so the counts are the counts. Answers 404 when the run had no
	 * rubric, which callers should treat as "no scorecard", not as an error.
	 *
	 * @param {string} runId
	 * @param {SurfaceContext} ctx
	 * @param {RequestOptions} [opts]
	 * @returns {Promise<any>}
	 */
	async function getJourneyRunScorecard(runId, ctx, opts = {}) {
		const config = getConfig(ctx, opts);
		return requestJson(
			`${config.baseUrl}/api/v1/projects/${encodeURIComponent(config.projectId)}/journey-runs/${encodeURIComponent(runId)}/scorecard`,
			{
				apiKey: config.apiKey,
				headers: config.headers,
				timeoutMs: RUN_TIMEOUT_MS,
				fetchImpl: opts.fetchImpl,
			},
		);
	}

	/**
	 * @param {SurfaceContext} ctx
	 * @param {RequestOptions} [opts]
	 * @returns {Promise<Array<{id: string, name: string}>>}
	 */
	async function listProjects(ctx, opts = {}) {
		const config = getConfig(ctx, {
			...opts,
			projectId: ctx.projectId || "unused",
		});
		const payload = await requestJson(`${config.baseUrl}/api/v1/projects`, {
			apiKey: config.apiKey,
			headers: config.headers,
			timeoutMs: RUN_TIMEOUT_MS,
			fetchImpl: opts.fetchImpl,
		});
		/** @type {Array<Record<string, any>>} */
		const items = Array.isArray(payload?.items)
			? payload.items
			: Array.isArray(payload?.data)
				? payload.data
				: Array.isArray(payload)
					? payload
					: [];
		return items
			.filter((/** @type {any} */ item) => item && typeof item.id === "string")
			.map((/** @type {any} */ item) => ({
				id: String(item.id),
				name: String(item.name ?? item.id),
			}));
	}

	return {
		getConfig,
		requestJson,
		runAgentTurn,
		executeProposedAction,
		startSuiteRun,
		getEvalRun,
		getEvalRunDecisionSummary,
		listEvalRunIterations,
		getEvalRunSteps,
		getJourneyRun,
		listJourneyRunSessions,
		getJourneyRunScorecard,
		listProjects,
	};
}

export const defaultApiClient = createApiClient();
export const {
	runAgentTurn,
	executeProposedAction,
	startSuiteRun,
	getEvalRun,
	getEvalRunDecisionSummary,
	listEvalRunIterations,
	getEvalRunSteps,
	getJourneyRun,
	listJourneyRunSessions,
	getJourneyRunScorecard,
	listProjects,
} = defaultApiClient;
