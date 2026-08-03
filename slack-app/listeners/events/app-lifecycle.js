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

  const revokedBotTokens = Array.isArray(event?.tokens?.bot) ? event.tokens.bot.map(String) : [];
  if (revokedBotTokens.length === 0) {
    logger?.info?.(`tokens_revoked for team ${teamId} named no bot tokens; installation untouched.`);
    return;
  }

  let record;
  try {
    record = await resolveInstallation(teamId);
  } catch (error) {
    // We cannot tell whether OUR bot token was the one revoked. Purging the
    // cache is the safe half of the decision (worst case, a re-fetch); the
    // durable revoke is deliberately NOT guessed at.
    purgeInstallation(teamId);
    logger?.error?.(`Could not resolve installation for team ${teamId} while handling tokens_revoked: ${error}`);
    return;
  }
  if (!record) return;

  if (!revokedBotTokens.includes(record.botUserId)) {
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
