/**
 * Installation lifecycle: uninstall and token revocation.
 *
 * These two events are the ONLY way a workspace tells us to stop acting on
 * its behalf, so they are also the only thing that makes the in-process
 * credential cache honest. Each handler purges the cache SYNCHRONOUSLY before
 * returning — a purge that happened only after the backend revoke landed
 * would leave a window where this process still answers with a token the
 * workspace just killed.
 */
import { purgeChannelBindings } from '../../agent/binding-cache.js';
import { revokeInstallationRecord } from '../../installations/backend-client.js';
import { purgeInstallation, resolveInstallation } from '../../installations/store.js';
import { sessionStore } from '../../thread-context/index.js';

/**
 * Forget everything this process holds for a workspace.
 * @param {string} teamId
 */
function purgeLocalState(teamId) {
  purgeInstallation(teamId);
  // Engaged threads are workspace state too: a reinstall should start from a
  // clean slate rather than resuming conversations the workspace ended.
  sessionStore.clearTeam(teamId);
  // So are channel→project bindings. A workspace that reconnects — possibly
  // into a different organization — must not have its first minute of turns
  // routed by the bindings of the install that just went away.
  purgeChannelBindings(teamId);
}

/**
 * `app_uninstalled` — the workspace removed the app. Unconditional revoke.
 * @param {Record<string, any>} args
 * @returns {Promise<void>}
 */
export async function handleAppUninstalled({ body, context, event, logger }) {
  const teamId = context?.teamId ?? body?.team_id ?? event?.team;
  if (!teamId) {
    logger?.warn?.('Received app_uninstalled with no team id; nothing to revoke.');
    return;
  }

  // Purge FIRST. Even if the backend revoke fails below, this process must
  // stop using the token immediately — the workspace has already withdrawn
  // consent, and a retry of the revoke is cheap compared to acting without it.
  purgeLocalState(teamId);

  try {
    await revokeInstallationRecord(teamId);
    logger?.info?.(`Revoked MCPJam installation for team ${teamId} (app_uninstalled).`);
  } catch (error) {
    // Loud, not fatal: the local purge already stopped this process. Slack
    // redelivers the event, and the backend revoke is idempotent.
    logger?.error?.(`Failed to revoke installation for team ${teamId}: ${error}`);
  }
}

/**
 * `tokens_revoked` — one or more tokens were revoked, which is NOT the same
 * as an uninstall. The event lists revoked `oauth` (user) and `bot` tokens;
 * a user revoking their own token must not take the workspace's bot offline.
 *
 * So this only counts as an installation revocation when the stored bot user
 * id actually appears in `tokens.bot`.
 *
 * @param {Record<string, any>} args
 * @returns {Promise<void>}
 */
export async function handleTokensRevoked({ body, context, event, logger }) {
  const teamId = context?.teamId ?? body?.team_id ?? event?.team;
  if (!teamId) {
    logger?.warn?.('Received tokens_revoked with no team id; ignoring.');
    return;
  }

  // `tokens.bot` is a list of USER IDS whose bot token was revoked, not a list
  // of token strings — Slack never puts a credential in an event payload. The
  // comparison below is therefore against the installation's `botUserId`.
  const revokedBotUserIds = Array.isArray(event?.tokens?.bot) ? event.tokens.bot.map(String) : [];
  if (revokedBotUserIds.length === 0) {
    logger?.info?.(`tokens_revoked for team ${teamId} named no bot tokens; installation untouched.`);
    return;
  }

  let record;
  try {
    record = await resolveInstallation(teamId);
  } catch (error) {
    // We cannot tell whether OUR bot token was the one revoked. Purging the
    // caches is the safe half of the decision (worst case, a re-fetch); the
    // durable revoke is deliberately NOT guessed at.
    //
    // Bindings go with the installation: they are re-read from the backend on
    // demand, so dropping them costs one round trip, while KEEPING them can
    // route a turn by the routing of an install that may have just been
    // revoked. Engaged threads are deliberately left alone — unlike a binding,
    // a dropped session is not re-fetchable, and this path can be reached by a
    // transient backend error on an event that was never about our bot.
    purgeInstallation(teamId);
    purgeChannelBindings(teamId);
    logger?.error?.(`Could not resolve installation for team ${teamId} while handling tokens_revoked: ${error}`);
    return;
  }
  if (!record) return;

  if (!record.botUserId) {
    // A stored installation with no bot user id cannot be matched against the
    // revocation list, so "not ours" is a GUESS — and guessing wrong here means
    // continuing to act with a token the workspace revoked. Purge locally (the
    // reversible half) and say so, rather than silently treating a genuine
    // revocation as unrelated.
    purgeLocalState(teamId);
    logger?.warn?.(
      `tokens_revoked for team ${teamId}: stored installation has no botUserId, so the revocation could not be ` +
        'attributed. Purged local state; the durable record was left in place for a re-fetch.',
    );
    return;
  }

  if (!revokedBotUserIds.includes(record.botUserId)) {
    logger?.info?.(`tokens_revoked for team ${teamId} named other bot tokens; MCPJam's installation is untouched.`);
    return;
  }

  purgeLocalState(teamId);
  try {
    await revokeInstallationRecord(teamId);
    logger?.info?.(`Revoked MCPJam installation for team ${teamId} (bot token revoked).`);
  } catch (error) {
    logger?.error?.(`Failed to revoke installation for team ${teamId}: ${error}`);
  }
}
