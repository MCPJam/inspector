/**
 * Global middleware: resolve the tenant for every inbound payload and decide
 * whether this workspace may run a turn at all.
 *
 * Distribution is activated during Phase 1/2 ONLY so we can test the install
 * flow against a second, throwaway workspace. Until per-user account linking
 * ships, the bot still acts with a single org-scoped `sk_` key from env — so
 * an event from any workspace OTHER than the legacy one would run that
 * workspace's request against OUR organization's project. That is a
 * cross-tenant data leak, not a degraded experience, so those events are
 * HARD-DROPPED here, before any agent call.
 *
 * This drop is removed in the PR that switches the bot to per-user `slk_`
 * credentials; from then on an unlinked user gets connect UX instead.
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

  if (!record.isLegacyWorkspace) {
    // The install succeeded and the workspace is genuinely ours to serve —
    // we simply have no per-workspace credentials for it yet. Silent is
    // correct for now: a "coming soon" reply in every channel of a test
    // workspace is noise, and the connect UX that replaces this drop is one
    // PR away.
    logger?.info?.(`Dropping an event from non-legacy team ${ctx.teamId}: per-user auth has not shipped yet.`);
    return;
  }

  // Publish the tenancy verdict so the credential seam (`getConfig`) can
  // assert it rather than re-deriving it. `context` is Bolt's per-request bag
  // and is what `slackContextFrom` reads.
  context.mcpjamTenancy = {
    isLegacyWorkspace: true,
    botUserId: record.botUserId,
  };

  await next();
}
