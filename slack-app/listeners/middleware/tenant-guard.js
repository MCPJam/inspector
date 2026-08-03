/**
 * Global middleware: resolve the tenant for every inbound payload and confirm
 * the workspace still has a live installation.
 *
 * It no longer decides whether a workspace may be SERVED — per-user auth has
 * shipped, so every installed workspace is served and the identity question is
 * answered per ACTOR further down (`resolveTurnTarget`): a linked user acts as
 * themselves, an unlinked one is offered a connect button. What stays here is
 * the one thing that is genuinely per-workspace: an event from a team with no
 * active installation is dropped, because we have no token to answer with and
 * no consent to act on.
 */
import { tryslackContextFrom } from '../../agent/slack-context.js';
import { InstallationBackendError } from '../../installations/backend-client.js';
import { resolveInstallation } from '../../installations/store.js';

/**
 * Payload types that must never be gated: they are how a workspace TELLS us
 * it revoked us. Dropping them would leave a revoked installation live in the
 * cache and the database.
 */
const LIFECYCLE_EVENT_TYPES = new Set(['app_uninstalled', 'tokens_revoked']);

/**
 * @param {Record<string, any>} args
 * @returns {boolean}
 */
function isLifecyclePayload(args) {
  const type = args?.payload?.type ?? args?.event?.type ?? args?.body?.event?.type;
  return typeof type === 'string' && LIFECYCLE_EVENT_TYPES.has(type);
}

/**
 * Bolt global middleware.
 * @param {Record<string, any>} args
 * @returns {Promise<void>}
 */
export async function tenantGuard(args) {
  const { body, context, event, payload, logger, next } = args;

  if (isLifecyclePayload(args)) {
    await next();
    return;
  }

  const ctx = tryslackContextFrom({ body, context, event, payload });
  if (!ctx) {
    // No tenant, no route. Not an error worth surfacing — Slack sends plenty
    // of payloads (channel_join, bot echoes) with no actionable actor.
    return;
  }

  let record;
  try {
    record = await resolveInstallation(ctx.teamId);
  } catch (error) {
    // A backend outage must not be reported as "you are not installed" and
    // must not silently run a turn under someone else's credentials. Drop the
    // event and let Slack's retry find a healthy process.
    if (error instanceof InstallationBackendError) {
      logger?.warn?.(`Tenant lookup failed for team ${ctx.teamId}; dropping event for retry.`);
      return;
    }
    throw error;
  }

  if (!record) {
    logger?.warn?.(`Dropping an event from team ${ctx.teamId}: no active installation.`);
    return;
  }

  // Publish the tenancy verdict so the credential seam (`getConfig`) can
  // assert it rather than re-deriving it. `context` is Bolt's per-request bag
  // and is what `slackContextFrom` reads. The legacy flag is now only about
  // whether the SHARED env key may be released — it no longer gates service.
  context.mcpjamTenancy = {
    isLegacyWorkspace: record.isLegacyWorkspace === true,
    botUserId: record.botUserId,
  };

  await next();
}
