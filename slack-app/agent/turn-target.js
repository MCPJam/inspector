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
 *   2. CHANNEL BINDING — an org admin's "everything said in #payments-eval
 *      lands in the Payments project". Below the thread binding because a
 *      thread that is already working somewhere must not be moved out from
 *      under it; above the replier's own default because it is a deliberate
 *      statement about THIS PLACE, and the whole point is that a member does
 *      not have to configure anything to use a channel the org set up.
 *   3. THE REPLIER'S DEFAULT PROJECT — for a new conversation.
 *   4. THE ORG'S DEFAULT PROJECT — the fallback for people who never picked
 *      one. Strictly BELOW the user's own default: the org default exists to
 *      remove the setup step, not to overrule an individual's choice.
 *   5. LEGACY ENV CREDENTIALS — only for the one pre-OAuth workspace, and
 *      only when the actor has not linked an account. Anyone who HAS linked
 *      acts as themselves, even there.
 *
 * A linked user with no default project AND no org default is not an error:
 * they are asked to pick one. An unlinked user in a non-legacy workspace is
 * not an error either: they are asked to connect. Both are UX states, and
 * conflating either with a failure is how a first-time user concludes the bot
 * is broken.
 */
import { InstallationBackendError } from '../installations/backend-client.js';
import { coalesceChannelBindingRead, getCachedChannelBinding } from './binding-cache.js';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * @typedef {Object} TurnTarget
 * @property {'user' | 'legacy' | 'needs_project' | 'unlinked'} mode
 * @property {string} [projectId]
 * @property {string} [organizationId]
 * @property {string} [initiatorSlackUserId]  Set when a thread binding applied.
 * @property {boolean} [boundThread]          True when a thread binding decided this.
 * @property {boolean} [boundChannel]         True when a CHANNEL binding decided this.
 * @property {boolean} [orgDefault]           True when the ORG's default project decided this.
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
 * The channel's binding, or null when it has none.
 *
 * READ-THROUGH CACHED, negatives included — see `binding-cache.js` for why
 * that differs from the installation store.
 *
 * A 404 (or 405) DEGRADES TO NULL rather than throwing: it means the backend
 * deployment predates this route, and "this backend has no channel bindings"
 * is a true and complete answer. That is what lets the bot deploy in either
 * order relative to the backend. Every other failure still throws, because an
 * unreachable backend must not be silently reported as "no binding" — that
 * would land a turn in the wrong project.
 *
 * @param {string} teamId
 * @param {string} channelId
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<import('./binding-cache.js').ChannelBinding | null>}
 */
export async function fetchChannelBinding(teamId, channelId, opts = {}) {
  const cached = getCachedChannelBinding(teamId, channelId);
  if (cached !== undefined) return cached;

  // Coalesced, so a cold-start burst in one channel makes ONE round trip and
  // cannot cache an older answer over a newer one. The coalescer writes the
  // cache; a throw propagates and caches nothing.
  return coalesceChannelBindingRead(teamId, channelId, async () => {
    try {
      const payload = await post('/slack/channel-bindings/get', { teamId, channelId }, opts);
      return payload?.binding ?? null;
    } catch (error) {
      if (error instanceof InstallationBackendError && (error.status === 404 || error.status === 405)) {
        return null;
      }
      throw error;
    }
  });
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

  // The channel binding and the speaker's link are fetched TOGETHER, because
  // the answer needs both and neither depends on the other. Sequentially this
  // would put a second round trip on the hot path of exactly the channels an
  // org configured to be frictionless.
  const [channelBinding, link] = await Promise.all([
    fetchChannelBinding(ctx.teamId, args.channelId, opts),
    fetchAccountLink(ctx.teamId, ctx.slackUserId, opts),
  ]);

  // An org admin bound this channel to a project. Below the thread binding
  // (an engaged thread is not moved) and above the speaker's own default (the
  // binding is a statement about this PLACE, and its whole value is that
  // nobody has to configure anything to use the channel).
  //
  // GATED ON BEING LINKED, unlike the thread binding above. A bound channel is
  // often where someone speaks to the bot for the FIRST time, and running an
  // unlinked person as `user` sends them to an inevitable 401 whose reply is a
  // sentence; falling through to `unlinked` gives them the connect BUTTON. The
  // thread binding can short-circuit because its initiator already resolved,
  // whereas anyone at all can be the first to post in a bound channel.
  if (link && channelBinding) {
    return {
      mode: 'user',
      projectId: channelBinding.projectId,
      organizationId: channelBinding.organizationId,
      boundChannel: true,
    };
  }

  if (link) {
    // The ORG's default is the fallback for someone who never picked, so it is
    // consulted only when the user's own default is absent — never as an
    // override. `orgDefaultProjectId` is absent entirely on a backend that
    // predates the field, which reads the same as "none set".
    if (link.defaultProjectId) {
      return {
        mode: 'user',
        projectId: link.defaultProjectId,
        organizationId: link.organizationId,
      };
    }
    if (link.orgDefaultProjectId) {
      return {
        mode: 'user',
        projectId: link.orgDefaultProjectId,
        organizationId: link.organizationId,
        orgDefault: true,
      };
    }
    return { mode: 'needs_project', organizationId: link.organizationId };
  }

  // Unlinked. The legacy workspace still works on the shared key so our own
  // team is not locked out mid-migration; everyone else is asked to connect.
  if (ctx.isLegacyWorkspace === true && process.env.MCPJAM_PROJECT_ID) {
    return { mode: 'legacy', projectId: process.env.MCPJAM_PROJECT_ID };
  }
  return { mode: 'unlinked' };
}
