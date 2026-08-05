// @ts-nocheck
const DEFAULT_BASE_URL = "https://app.mcpjam.com";
const TURN_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 30_000;
const EXECUTE_ACTION_TIMEOUT_MS = 150_000;

/** @typedef {{ role: 'user'|'assistant', content: string }} TurnMessage */
/** @typedef {{ actionId:string, operation:string, description:string }} ProposedAction */

export class McpjamApiError extends Error {
	/** @param {string} message @param {{code?:string,status?:number,details?:Record<string,any>}} [opts] */
	constructor(message, opts = {}) {
		super(message);
		this.name = "McpjamApiError";
		this.code = opts.code;
		this.status = opts.status;
		this.details = opts.details;
	}

	/** @returns {import('./copy.js').StructuredContent} */
	get structuredContent() {
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
				messages[this.code] ||
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
 * Create the API client for one surface. The transport knows only the
 * injected wire config; rendering and platform names never enter this file.
 * @param {{surfaceKind?:string, routePrefix?:string, conversationField?:string, authHeaderName?:string, identityHeaders?:(ctx:any)=>Record<string,string>, getConfig?:(ctx:any,overrides?:any)=>any, baseUrl?:string, fetchImpl?:typeof fetch}} [options]
 */
export function createApiClient(options = {}) {
	const routePrefix = options.routePrefix ?? "/agent";
	const conversationField = options.conversationField ?? "conversationId";
	const identityHeaders =
		options.identityHeaders ??
		((ctx) => ({
			"x-mcpjam-surface-tenant-id": String(ctx.tenantId),
			"x-mcpjam-surface-actor-id": String(ctx.actorId),
		}));
	const fetchDefault = options.fetchImpl ?? fetch;

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
			fetchImpl = fetchDefault,
			idempotencyKey,
			headers = {},
		},
	) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetchImpl(url, {
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
				if (!(error instanceof SyntaxError)) throw error;
			}
			if (!response.ok)
				throw new McpjamApiError(
					payload?.message || `MCPJam API error (${response.status})`,
					{
						code: payload?.code,
						status: response.status,
						details: payload?.details,
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
			result,
			runUrl:
				runId && suiteId
					? `${config.appUrl}/evals/suite/${encodeURIComponent(suiteId)}/runs/${encodeURIComponent(runId)}?project=${encodeURIComponent(config.projectId)}`
					: null,
		};
	}

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
			url: `${config.appUrl}/evals/suite/${encodeURIComponent(suiteId)}/runs/${encodeURIComponent(runId)}?project=${encodeURIComponent(config.projectId)}`,
		};
	}

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

	async function listEvalRunIterations(runId, ctx, opts = {}) {
		const config = getConfig(ctx, opts);
		const payload = await requestJson(
			`${config.baseUrl}/api/v1/projects/${encodeURIComponent(config.projectId)}/eval-runs/${encodeURIComponent(runId)}/iterations`,
			{
				apiKey: config.apiKey,
				headers: config.headers,
				timeoutMs: RUN_TIMEOUT_MS,
				fetchImpl: opts.fetchImpl,
			},
		);
		return Array.isArray(payload?.items) ? payload.items : [];
	}

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
		const items = Array.isArray(payload?.items)
			? payload.items
			: Array.isArray(payload?.data)
				? payload.data
				: Array.isArray(payload)
					? payload
					: [];
		return items
			.filter((item) => item && typeof item.id === "string")
			.map((item) => ({
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
		listEvalRunIterations,
		getEvalRunSteps,
		listProjects,
	};
}

export const defaultApiClient = createApiClient();
export const {
	runAgentTurn,
	executeProposedAction,
	startSuiteRun,
	getEvalRun,
	listEvalRunIterations,
	getEvalRunSteps,
	listProjects,
} = defaultApiClient;
