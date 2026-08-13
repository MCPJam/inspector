/**
 * Slack's binding to the shared turn-target resolver and channel-binding
 * cache.
 *
 * The precedence ladder (thread binding → channel binding → the speaker's
 * default → the org's default → legacy tenant → unlinked) and the channel
 * cache's correctness properties (miss-vs-negative, coalescing, outage-not-
 * cached) now live in `@mcpjam/surface-core`, verified there by its own
 * tests. What stays HERE is everything Slack-specific:
 *
 *   - Slack's own vocabulary (`teamId`/`slackUserId`) and the exact function
 *     names/signatures every other file in this app already calls.
 *   - THE WIRE SHAPE. `/slack/*` is Slack's own, OLDER route family —
 *     `{teamId, channelId, threadTs, initiatorSlackUserId}` — not the
 *     generalized `/agent/*` shape (`surfaceKind`/`surfaceTenantId`/
 *     `surfaceUserId`/`initiatorSurfaceUserId`) discord-app's routes speak.
 *     The core's `createBackendClient` convenience methods
 *     (`fetchThreadBinding`, `createThreadBinding`, …) send the GENERIC
 *     shape and would 400 against `/slack/*`, so this file uses only
 *     `backend.post()` — the transport (timeout, JSON-guard, error mapping),
 *     not the wire contract — and builds Slack's own body itself.
 */
import { createChannelBindingCache, createTurnTargetResolver, InstallationBackendError } from '@mcpjam/surface-core';
import { backend } from '../installations/backend-client.js';
import { toSurfaceCtx } from './surface-ctx.js';

/** True when per-user credentials are configured at all. */
export function hasPerUserAuth() {
  return Boolean(process.env.MCPJAM_SLACK_SERVICE_TOKEN);
}

/**
 * @param {string} teamId
 * @param {string} channelId
 * @param {string} threadTs
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function fetchThreadBinding(teamId, channelId, threadTs, opts = {}) {
  const payload = await backend.post('/slack/thread-bindings/get', { teamId, channelId, threadTs }, opts);
  return payload?.binding ?? null;
}

/**
 * A backend that predates this route answers 404/405, which reads the same
 * as "no binding" — the alternative is a bot that cannot resolve a turn at
 * all until the backend catches up. Any other failure still throws: "we
 * could not ask" must not become "there is none".
 *
 * @param {string} teamId
 * @param {string} channelId
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
async function fetchChannelBinding(teamId, channelId, opts = {}) {
  try {
    const payload = await backend.post('/slack/channel-bindings/get', { teamId, channelId }, opts);
    return payload?.binding ?? null;
  } catch (error) {
    if (error instanceof InstallationBackendError && (error.status === 404 || error.status === 405)) return null;
    throw error;
  }
}

/**
 * @param {string} teamId
 * @param {string} slackUserId
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export async function fetchAccountLink(teamId, slackUserId, opts = {}) {
  const payload = await backend.post('/slack/links/fetch', { teamId, slackUserId }, opts);
  return payload?.link ?? null;
}

/**
 * @param {string} teamId
 * @param {string} slackUserId
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export function revokeAccountLink(teamId, slackUserId, opts = {}) {
  return backend.post('/slack/links/revoke', { teamId, slackUserId }, opts);
}

/**
 * Bind a thread to the initiator's org/project. First writer wins; the
 * returned binding is authoritative even when this call did not create it.
 * @param {{ teamId: string, channelId: string, threadTs: string, organizationId: string, projectId: string, initiatorSlackUserId: string }} args
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 */
export function createThreadBinding(args, opts = {}) {
  return backend.post('/slack/thread-bindings/create', args, opts);
}

// Process-local, like every cache in this app: the Railway service is
// pinned to one replica (see railway.toml).
const channelBindingCache = createChannelBindingCache();

/**
 * The same key `createTurnTargetResolver` composes internally.
 * @param {string} teamId @param {string} channelId
 */
const channelCacheKey = (teamId, channelId) => `slack:${teamId}:${channelId}`;

/**
 * Test-only: observe/seed the cache the resolver actually reads from.
 * @param {string} teamId @param {string} channelId
 */
export function getCachedChannelBinding(teamId, channelId) {
  return channelBindingCache.get(channelCacheKey(teamId, channelId));
}

/**
 * Test-only.
 * @param {string} teamId @param {string} channelId @param {any} binding
 */
export function setCachedChannelBinding(teamId, channelId, binding) {
  channelBindingCache.set(channelCacheKey(teamId, channelId), binding);
}

const resolveCore = createTurnTargetResolver({
  // An adapter matching the shape `createTurnTargetResolver` expects
  // (`{tenantId, actorId}` ctx), implemented against Slack's OWN wire
  // contract above — not the core's generic `createBackendClient` methods.
  backend: {
    /** @param {{tenantId:string,actorId:string}} ctx @param {string} conversationId @param {string} threadId @param {{fetchImpl?: typeof fetch}} opts */
    fetchThreadBinding: (ctx, conversationId, threadId, opts) =>
      fetchThreadBinding(ctx.tenantId, conversationId, threadId, opts),
    /** @param {{tenantId:string,actorId:string}} ctx @param {string} conversationId @param {{fetchImpl?: typeof fetch}} opts */
    fetchChannelBinding: (ctx, conversationId, opts) => fetchChannelBinding(ctx.tenantId, conversationId, opts),
    /** @param {{tenantId:string,actorId:string}} ctx @param {{fetchImpl?: typeof fetch}} opts */
    fetchAccountLink: (ctx, opts) => fetchAccountLink(ctx.tenantId, ctx.actorId, opts),
  },
  surfaceKind: 'slack',
  hasPerUserAuth,
  legacyProjectId: () => process.env.MCPJAM_PROJECT_ID,
  channelBindingCache,
});

/**
 * @typedef {Object} TurnTarget
 * @property {'user' | 'legacy' | 'needs_project' | 'unlinked'} mode
 * @property {string} [projectId]
 * @property {string} [organizationId]
 * @property {string} [initiatorSlackUserId]
 * @property {boolean} [boundThread]
 * @property {boolean} [boundChannel]
 * @property {boolean} [orgDefault]
 */

/**
 * @param {import('./slack-context.js').SlackContext} ctx
 * @param {{ channelId: string, threadTs: string, fetchImpl?: typeof fetch }} args
 * @returns {Promise<TurnTarget>}
 */
export async function resolveTurnTarget(ctx, args) {
  const target = await resolveCore(toSurfaceCtx(ctx), {
    conversationId: args.channelId,
    threadId: args.threadTs,
    fetchImpl: args.fetchImpl,
  });
  // This app has only ever spelled the initiator field the Slack way; the
  // core reads either name off a stored binding (see the thread-binding
  // route's `initiatorActorId || initiatorSlackUserId` fallback).
  return target.initiatorActorId ? { ...target, initiatorSlackUserId: target.initiatorActorId } : target;
}

/**
 * Drop everything cached for one workspace.
 *
 * Wired into the same lifecycle events that purge the installation cache:
 * uninstall, a bot-token revoke, and reinstall. A workspace that reconnects —
 * possibly into a DIFFERENT organization — must not have its first minute of
 * turns routed by the bindings of the install that just went away.
 *
 * @param {string} teamId
 */
export function purgeChannelBindings(teamId) {
  channelBindingCache.clearTenant(`slack:${teamId}:`);
}
