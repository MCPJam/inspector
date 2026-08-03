/**
 * Thin client for the MCPJam public API — the bot's only "brain" is the
 * server-side agent endpoint. No LLM key or agent loop lives in this app.
 *
 * RETRY POLICY: never blind-retry a turn. The endpoint is not idempotent —
 * a lost response may still have persisted an eval suite. Dedupe lives at
 * the trigger (turn-runner's tenant+channel+event-ts registry); this client
 * makes exactly one attempt per call, on purpose.
 *
 * TENANCY: every entry point takes a `SlackContext` ({teamId, slackUserId})
 * and resolves credentials through `getConfig(ctx)`. This is the single
 * chokepoint where "which workspace is this?" becomes "which credentials and
 * which project?" — so the multi-workspace switch is one function's problem,
 * not every call site's. Today it still answers from env for every tenant;
 * the ctx is threaded first (and asserted) so that switch cannot miss a
 * caller later.
 *
 * Env:
 *   MCPJAM_API_KEY    — sk_… key minted in the MCPJam app (Settings → API keys)
 *   MCPJAM_PROJECT_ID — the project every turn is scoped to
 *   MCPJAM_BASE_URL   — defaults to https://app.mcpjam.com
 */

const DEFAULT_BASE_URL = 'https://app.mcpjam.com';
// Slightly above the server's 90s turn wall clock.
const TURN_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 30_000;

/** @typedef {{ role: 'user' | 'assistant', content: string }} TurnMessage */
/**
 * @typedef {Object} AgentTurnResult
 * @property {string} reply
 * @property {Array<{ operation: string }>} toolCalls
 * @property {Array<{ type: string, id: string, name?: string, url: string }>} createdResources
 * @property {Array<ProposedAction>} [proposedActions]
 */
/**
 * An action the turn wants to take but is not allowed to take on its own.
 * Rendered as a button; the click is the approval that spends.
 * @typedef {Object} ProposedAction
 * @property {string} actionId
 * @property {string} operation
 * @property {string} description
 */

export class McpjamApiError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'McpjamApiError';
    this.code = opts.code;
    this.status = opts.status;
  }

  /** A short, user-facing Slack message for this failure. */
  get friendlyMessage() {
    if (this.code === 'RATE_LIMITED') {
      return ":hourglass_flowing_sand: I'm at capacity right now — give it a minute and try again.";
    }
    if (this.code === 'TIMEOUT') {
      return ':hourglass: That took longer than I allow for one reply. Try breaking the request into smaller steps.';
    }
    if (this.code === 'SERVER_UNREACHABLE') {
      // A backend blip must never be reported as an auth problem: the user
      // would go and re-link an account that was already fine.
      return ":satellite: I can't reach MCPJam right now. Try again in a moment.";
    }
    if (this.code === 'UNAUTHORIZED') {
      return ':link: I need you to connect your MCPJam account before I can do that.';
    }
    if (this.code === 'FORBIDDEN') {
      // The clamp and the delegated mint both enforce project access. The
      // common cause is a thread bound to a project the replier can't reach.
      return ":lock: You don't have access to the project this thread is working in.";
    }
    return ':warning: Something went wrong talking to MCPJam. Try again in a moment.';
  }
}

/**
 * Resolve the credentials and project one Slack event should act with.
 *
 * TWO MODES, and the ctx says which:
 *
 *   'user'   — the actor has linked their MCPJam account. The bot presents its
 *              `slk_` service credential plus the Slack team/user headers, and
 *              the server resolves the LINKED USER's identity from them. The
 *              bot never holds a user token: delegated JWTs are portable
 *              2-hour org credentials, and a compromised bot must not be able
 *              to harvest them.
 *   'legacy' — the one pre-OAuth workspace, acting on the shared org-scoped
 *              `sk_` key. Gated on the tenant guard's verdict and re-asserted
 *              HERE, at the credential seam: this is the last point before a
 *              secret is handed out, and a call path that forgot the guard
 *              must fail closed rather than inherit our organization's key.
 *
 * @param {import('./slack-context.js').SlackContext & { mode?: 'user' | 'legacy', projectId?: string }} ctx
 */
export function getConfig(ctx) {
  if (!ctx?.teamId || !ctx?.slackUserId) {
    throw new McpjamApiError('MCPJam credentials were requested without a Slack tenant context.', { code: 'CONFIG' });
  }
  const baseUrl = (process.env.MCPJAM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  // Deep links can point somewhere other than the API host — in local dev
  // the API is on :6274 while the app UI is served on :5173.
  const appUrl = (process.env.MCPJAM_APP_URL || baseUrl).replace(/\/+$/, '');

  if (ctx.mode === 'user') {
    const serviceToken = process.env.MCPJAM_SLACK_SERVICE_TOKEN;
    if (!serviceToken) {
      throw new McpjamApiError('MCPJAM_SLACK_SERVICE_TOKEN must be set to act as a linked user.', {
        code: 'CONFIG',
      });
    }
    if (!ctx.projectId) {
      throw new McpjamApiError('No project resolved for this turn.', { code: 'NO_PROJECT' });
    }
    return {
      apiKey: serviceToken,
      projectId: ctx.projectId,
      baseUrl,
      appUrl,
      // The identity. Without both, the server has no user to act as and
      // answers 401 — which is the correct outcome, not a fallback.
      headers: /** @type {Record<string, string>} */ ({
        'x-mcpjam-slack-team-id': ctx.teamId,
        'x-mcpjam-slack-user-id': ctx.slackUserId,
      }),
    };
  }

  if (ctx.isLegacyWorkspace !== true) {
    throw new McpjamApiError(
      `Workspace ${ctx.teamId} has no MCPJam credentials: the shared API key is scoped to the legacy workspace only.`,
      { code: 'UNAUTHORIZED' },
    );
  }
  const apiKey = process.env.MCPJAM_API_KEY;
  const projectId = ctx.projectId || process.env.MCPJAM_PROJECT_ID;
  if (!apiKey || !projectId) {
    throw new McpjamApiError('MCPJAM_API_KEY and MCPJAM_PROJECT_ID must be set (see .env.sample).', { code: 'CONFIG' });
  }
  return { apiKey, projectId, baseUrl, appUrl, headers: /** @type {Record<string, string>} */ ({}) };
}

/**
 * One JSON request with a timeout that covers the WHOLE exchange, body
 * included — clearing the timer once headers arrive would let a response
 * that never finishes its body hang the caller forever.
 *
 * @param {string} url
 * @param {{ method?: string, body?: Record<string, unknown>, apiKey: string, timeoutMs: number, fetchImpl?: typeof fetch, idempotencyKey?: string, headers?: Record<string, string> }} opts
 * @returns {Promise<any>}
 */
async function requestJson(
  url,
  { method = 'GET', body, apiKey, timeoutMs, fetchImpl = fetch, idempotencyKey, headers: extraHeaders = {} },
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        // Transport-level, not a body field: the write routes read the key
        // from here so it applies uniformly and can never be shaped by
        // model output.
        ...(idempotencyKey ? { 'x-mcpjam-idempotency-key': idempotencyKey } : {}),
        ...extraHeaders,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });

    /** @type {any} */
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      // A body that isn't JSON (an HTML error page, an empty 204) is fine —
      // `payload` stays null and the status decides. Anything else is a real
      // failure mid-body: the abort firing while the body streamed, or a
      // dropped connection. Those MUST NOT be laundered into "no body" and
      // returned as success — headers already arrived, so `response.ok` is
      // true and the stall would be reported as an empty, successful reply.
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!response.ok) {
      throw new McpjamApiError(payload?.message || `MCPJam API error (${response.status})`, {
        code: payload?.code,
        status: response.status,
      });
    }
    return payload;
  } catch (error) {
    if (error instanceof McpjamApiError) throw error;
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new McpjamApiError(aborted ? `Request timed out after ${timeoutMs}ms` : `Request failed: ${error}`, {
      code: aborted ? 'TIMEOUT' : 'NETWORK',
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one agent turn.
 *
 * `idempotencyKey` must be the STABLE identity of the triggering Slack event
 * (`${teamId}:${event_id}`), never a fresh value per attempt: the server
 * derives a per-write key from it, so a retried turn's mutations land on the
 * rows the first attempt created instead of authoring duplicates. A uuid
 * regenerated per call would silently disable that.
 *
 * @param {TurnMessage[]} messages
 * @param {import('./slack-context.js').SlackContext} ctx
 * `channelId` is what makes the SPENDING tools available at all: the server
 * only offers them when it knows where an approval button can be rendered, so
 * omitting it means the model is never given a run/generate/cancel tool to
 * call. That is the intended degradation — the alternative would be proposals
 * queued somewhere nobody can approve them.
 *
 * @param {TurnMessage[]} messages
 * @param {import('./slack-context.js').SlackContext} ctx
 * @param {{ fetchImpl?: typeof fetch, idempotencyKey?: string, channelId?: string }} [opts]
 * @returns {Promise<AgentTurnResult>}
 */
export async function runAgentTurn(messages, ctx, opts = {}) {
  const { apiKey, projectId, baseUrl, headers } = getConfig(ctx);
  const url = `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/agent`;
  const payload = await requestJson(url, {
    method: 'POST',
    body: {
      messages,
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.channelId ? { slackChannelId: opts.channelId } : {}),
    },
    apiKey,
    headers,
    timeoutMs: TURN_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
  return {
    reply: typeof payload?.reply === 'string' ? payload.reply : '',
    toolCalls: Array.isArray(payload?.toolCalls) ? payload.toolCalls : [],
    createdResources: Array.isArray(payload?.createdResources) ? payload.createdResources : [],
    proposedActions: Array.isArray(payload?.proposedActions) ? payload.proposedActions : [],
  };
}

/**
 * Execute an action a human just approved by clicking.
 *
 * `ctx` MUST carry the CLICKER's Slack user id, not the proposer's: the server
 * resolves the acting identity from these headers and mints the delegated token
 * for that person, so this is where "the clicker is the authorizer" is actually
 * enforced. Passing the proposer through here would silently spend someone
 * else's quota under their identity.
 *
 * Only `actionId` travels. What it DOES is read from the persisted proposal
 * server-side — a Block Kit button's value can be minted by anyone able to post
 * in the workspace, so a click may only say WHICH action to run.
 *
 * @param {string} actionId
 * @param {import('./slack-context.js').SlackContext & { mode?: 'user' | 'legacy', projectId?: string }} ctx
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ status: string, result: any }>}
 */
export async function executeProposedAction(actionId, ctx, opts = {}) {
  const { apiKey, projectId, baseUrl, headers } = getConfig(ctx);
  const url = `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/proposed-actions/${encodeURIComponent(actionId)}/execute`;
  const payload = await requestJson(url, {
    method: 'POST',
    apiKey,
    headers,
    timeoutMs: TURN_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
  return {
    status: typeof payload?.status === 'string' ? payload.status : 'succeeded',
    result: payload?.result ?? null,
  };
}

/**
 * Start an eval-suite run. This is the human-gated action behind the Slack
 * "Run it" button — the agent turn itself can never start runs.
 * `idempotencyKey` is the click's action id. A run costs quota, so the two
 * hazards are a double-click and a crash between starting the run and
 * recording that it started; both re-issue the same key and land on the SAME
 * backend run rather than billing a second one.
 *
 * @param {string} suiteId
 * @param {import('./slack-context.js').SlackContext} ctx
 * @param {{ fetchImpl?: typeof fetch, idempotencyKey?: string }} [opts]
 * @returns {Promise<{ runId: string, suiteId: string, url: string }>}
 */
export async function startSuiteRun(suiteId, ctx, opts = {}) {
  const { apiKey, projectId, baseUrl, appUrl, headers } = getConfig(ctx);
  const url = `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/eval-runs`;
  const payload = await requestJson(url, {
    method: 'POST',
    body: { suiteId },
    apiKey,
    headers,
    timeoutMs: RUN_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
  });
  const runId = String(payload?.runId ?? '');
  // A run without an id can't be linked or polled — surface it instead of
  // posting a deep link to `/runs/?project=…`.
  if (!runId) {
    throw new McpjamApiError('MCPJam started a run but returned no run id.', { code: 'INTERNAL_ERROR' });
  }
  return {
    runId,
    suiteId,
    // `?project=` makes the link land on the right project for viewers whose
    // picker is parked elsewhere (eval routes carry no project segment).
    url: `${appUrl}/evals/suite/${encodeURIComponent(suiteId)}/runs/${encodeURIComponent(runId)}?project=${encodeURIComponent(projectId)}`,
  };
}

/**
 * Poll one run's status/result.
 * @param {string} runId
 * @param {import('./slack-context.js').SlackContext} ctx
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ status: string, result: string | null, summary?: { total?: number, passed?: number, failed?: number, passRate?: number } }>}
 */
export async function getEvalRun(runId, ctx, opts = {}) {
  const { apiKey, projectId, baseUrl, headers } = getConfig(ctx);
  const url = `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/eval-runs/${encodeURIComponent(runId)}`;
  return requestJson(url, { apiKey, headers, timeoutMs: RUN_TIMEOUT_MS, fetchImpl: opts.fetchImpl });
}

/**
 * Projects the linked user can see, for the App Home picker.
 *
 * Uses the same per-user credentials as everything else, so the list is
 * exactly what THAT user may act in — never a superset borrowed from the
 * bot's own identity, which is the mistake that would make the picker offer
 * projects the user cannot actually use.
 *
 * @param {import('./slack-context.js').SlackContext & { mode?: 'user' | 'legacy', projectId?: string }} ctx
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
export async function listProjects(ctx, opts = {}) {
  const { apiKey, baseUrl, headers } = getConfig({ ...ctx, projectId: ctx.projectId || 'unused' });
  const payload = await requestJson(`${baseUrl}/api/v1/projects`, {
    apiKey,
    headers,
    timeoutMs: RUN_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
  // The v1 collection envelope is `{ items: [...] }`. `data`/bare-array are
  // kept as fallbacks so a shape change degrades to a smaller picker rather
  // than an empty one that reads as "you have no projects".
  /** @type {Array<Record<string, any>>} */
  const items = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload)
        ? payload
        : [];
  return items
    .filter((item) => item && typeof item.id === 'string')
    .map((item) => ({ id: String(item.id), name: String(item.name ?? item.id) }));
}
