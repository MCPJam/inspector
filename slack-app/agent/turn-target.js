/**
 * Resolve WHOSE credentials a turn runs with and WHICH project it lands in.
 *
 * This is the whole tenancy decision in one place, and its ordering is the
 * product rule:
 *
 *   1. THREAD BINDING — authoritative once a thread is engaged. Without it,
 *      each reply would re-resolve from whoever spoke last, so a thread could
 *      silently drift between projects mid-conversation and a suite could land
 *      somewhere nobody expected. The binding is durable, which is also what
 *      lets an engaged thread survive a bot restart.
 *   2. THE REPLIER'S DEFAULT PROJECT — for a new conversation.
 *   3. LEGACY ENV CREDENTIALS — only for the one pre-OAuth workspace, and
 *      only when the actor has not linked an account. Anyone who HAS linked
 *      acts as themselves, even there.
 *
 * A linked user with no default project is not an error: they are asked to
 * pick one. An unlinked user in a non-legacy workspace is not an error either:
 * they are asked to connect. Both are UX states, and conflating either with a
 * failure is how a first-time user concludes the bot is broken.
 */
import { InstallationBackendError } from '../installations/backend-client.js';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * @typedef {Object} TurnTarget
 * @property {'user' | 'legacy' | 'needs_project' | 'unlinked'} mode
 * @property {string} [projectId]
 * @property {string} [organizationId]
 * @property {string} [initiatorSlackUserId]  Set when a thread binding applied.
 * @property {boolean} [boundThread]          True when a binding decided this.
 */

function backendConfig() {
  const baseUrl = (process.env.MCPJAM_CONVEX_HTTP_URL || '').replace(/\/+$/, '');
  const serviceToken = process.env.SLACK_SERVICE_TOKEN;
  if (!baseUrl || !serviceToken) {
    throw new InstallationBackendError('Backend config is required to resolve a turn target.', {
      code: 'CONFIG',
    });
  }
  return { baseUrl, serviceToken };
}

/** True when per-user credentials are configured at all. */
export function hasPerUserAuth() {
  return Boolean(process.env.MCPJAM_SLACK_SERVICE_TOKEN);
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
async function post(path, body, opts = {}) {
  const { baseUrl, serviceToken } = backendConfig();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-slack-service-token': serviceToken,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    /** @type {any} */
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (!response.ok) {
      throw new InstallationBackendError(payload?.error || `Backend error (${response.status})`, {
        status: response.status,
      });
    }
    return payload;
  } catch (error) {
    if (error instanceof InstallationBackendError) throw error;
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new InstallationBackendError(aborted ? 'Backend request timed out' : `Backend request failed: ${error}`, {
      code: aborted ? 'TIMEOUT' : 'NETWORK',
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} teamId
 * @param {string} channelId
 * @param {string} threadTs
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function fetchThreadBinding(teamId, channelId, threadTs, opts = {}) {
  const payload = await post('/slack/thread-bindings/get', { teamId, channelId, threadTs }, opts);
  return payload?.binding ?? null;
}

/**
 * @param {string} teamId
 * @param {string} slackUserId
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function fetchAccountLink(teamId, slackUserId, opts = {}) {
  const payload = await post('/slack/links/fetch', { teamId, slackUserId }, opts);
  return payload?.link ?? null;
}

/**
 * Bind a thread to the initiator's org/project. First writer wins; the
 * returned binding is authoritative even when this call did not create it.
 * @param {{ teamId: string, channelId: string, threadTs: string, organizationId: string, projectId: string, initiatorSlackUserId: string }} args
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function createThreadBinding(args, opts = {}) {
  return post('/slack/thread-bindings/create', args, opts);
}

/**
 * @param {string} teamId
 * @param {string} slackUserId
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function revokeAccountLink(teamId, slackUserId, opts = {}) {
  return post('/slack/links/revoke', { teamId, slackUserId }, opts);
}

/**
 * @param {import('./slack-context.js').SlackContext} ctx
 * @param {{ channelId: string, threadTs: string, fetchImpl?: typeof fetch }} args
 * @returns {Promise<TurnTarget>}
 */
export async function resolveTurnTarget(ctx, args) {
  const opts = args.fetchImpl ? { fetchImpl: args.fetchImpl } : {};

  // Legacy-only deployments (local dev, or before the service token is
  // issued) never had per-user auth to begin with.
  //
  // Note the deliberate asymmetry with the legacy fallback at the bottom of
  // this function, which additionally requires MCPJAM_PROJECT_ID: THERE,
  // per-user auth exists, so falling through to `unlinked` gives the user a
  // connect button they can actually use. HERE it does not, so `unlinked`
  // would show a connect flow that cannot complete. Returning `legacy` with no
  // project instead surfaces the credential seam's config error — which names
  // the missing variable, and is aimed at the operator who can fix it.
  if (!hasPerUserAuth()) {
    return ctx.isLegacyWorkspace === true
      ? { mode: 'legacy', projectId: process.env.MCPJAM_PROJECT_ID }
      : { mode: 'unlinked' };
  }

  const binding = await fetchThreadBinding(ctx.teamId, args.channelId, args.threadTs, opts);
  if (binding) {
    // A bound thread does not re-resolve. The replier still has to be linked
    // and still has to have access to the bound project — but that is
    // enforced server-side (the delegated mint re-verifies membership), not
    // by silently choosing a different project for them.
    return {
      mode: 'user',
      projectId: binding.projectId,
      organizationId: binding.organizationId,
      initiatorSlackUserId: binding.initiatorSlackUserId,
      boundThread: true,
    };
  }

  const link = await fetchAccountLink(ctx.teamId, ctx.slackUserId, opts);
  if (link) {
    if (!link.defaultProjectId) {
      return { mode: 'needs_project', organizationId: link.organizationId };
    }
    return {
      mode: 'user',
      projectId: link.defaultProjectId,
      organizationId: link.organizationId,
    };
  }

  // Unlinked. The legacy workspace still works on the shared key so our own
  // team is not locked out mid-migration; everyone else is asked to connect.
  if (ctx.isLegacyWorkspace === true && process.env.MCPJAM_PROJECT_ID) {
    return { mode: 'legacy', projectId: process.env.MCPJAM_PROJECT_ID };
  }
  return { mode: 'unlinked' };
}
