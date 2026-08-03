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
    if (this.code === 'UNAUTHORIZED' || this.code === 'FORBIDDEN') {
      return ':lock: My MCPJam credentials look wrong — an admin needs to check the API key configuration.';
    }
    return ':warning: Something went wrong talking to MCPJam. Try again in a moment.';
  }
}

/**
 * Resolve the credentials and project one Slack event should act with.
 *
 * LEGACY-ONLY FALLBACK. The env `sk_` key is org-scoped to OUR organization,
 * so serving any other workspace with it would run that workspace's request
 * against our project — a cross-tenant leak, not a degraded experience. The
 * key is therefore released only when the tenant guard has affirmatively
 * marked this event as coming from the one pre-OAuth workspace. The check is
 * re-asserted HERE, at the credential seam, rather than trusted from the
 * guard alone: this is the last point before a secret is handed out, and a
 * new call path that forgets the guard must fail closed instead of inheriting
 * our organization's credentials.
 *
 * @param {import('./slack-context.js').SlackContext} ctx
 */
export function getConfig(ctx) {
  if (!ctx?.teamId || !ctx?.slackUserId) {
    throw new McpjamApiError('MCPJam credentials were requested without a Slack tenant context.', { code: 'CONFIG' });
  }
  if (ctx.isLegacyWorkspace !== true) {
    throw new McpjamApiError(
      `Workspace ${ctx.teamId} has no MCPJam credentials: the shared API key is scoped to the legacy workspace only.`,
      { code: 'UNAUTHORIZED' },
    );
  }
  const apiKey = process.env.MCPJAM_API_KEY;
  const projectId = process.env.MCPJAM_PROJECT_ID;
  const baseUrl = (process.env.MCPJAM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  // Deep links can point somewhere other than the API host — in local dev
  // the API is on :6274 while the app UI is served on :5173.
  const appUrl = (process.env.MCPJAM_APP_URL || baseUrl).replace(/\/+$/, '');
  if (!apiKey || !projectId) {
    throw new McpjamApiError('MCPJAM_API_KEY and MCPJAM_PROJECT_ID must be set (see .env.sample).', { code: 'CONFIG' });
  }
  return { apiKey, projectId, baseUrl, appUrl };
}

/**
 * One JSON request with a timeout that covers the WHOLE exchange, body
 * included — clearing the timer once headers arrive would let a response
 * that never finishes its body hang the caller forever.
 *
 * @param {string} url
 * @param {{ method?: string, body?: Record<string, unknown>, apiKey: string, timeoutMs: number, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<any>}
 */
async function requestJson(url, { method = 'GET', body, apiKey, timeoutMs, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
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
 * @param {TurnMessage[]} messages
 * @param {import('./slack-context.js').SlackContext} ctx
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<AgentTurnResult>}
 */
export async function runAgentTurn(messages, ctx, opts = {}) {
  const { apiKey, projectId, baseUrl } = getConfig(ctx);
  const url = `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/agent`;
  const payload = await requestJson(url, {
    method: 'POST',
    body: { messages },
    apiKey,
    timeoutMs: TURN_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
  return {
    reply: typeof payload?.reply === 'string' ? payload.reply : '',
    toolCalls: Array.isArray(payload?.toolCalls) ? payload.toolCalls : [],
    createdResources: Array.isArray(payload?.createdResources) ? payload.createdResources : [],
  };
}

/**
 * Start an eval-suite run. This is the human-gated action behind the Slack
 * "Run it" button — the agent turn itself can never start runs.
 * @param {string} suiteId
 * @param {import('./slack-context.js').SlackContext} ctx
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<{ runId: string, suiteId: string, url: string }>}
 */
export async function startSuiteRun(suiteId, ctx, opts = {}) {
  const { apiKey, projectId, baseUrl, appUrl } = getConfig(ctx);
  const url = `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/eval-runs`;
  const payload = await requestJson(url, {
    method: 'POST',
    body: { suiteId },
    apiKey,
    timeoutMs: RUN_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
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
  const { apiKey, projectId, baseUrl } = getConfig(ctx);
  const url = `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/eval-runs/${encodeURIComponent(runId)}`;
  return requestJson(url, { apiKey, timeoutMs: RUN_TIMEOUT_MS, fetchImpl: opts.fetchImpl });
}
