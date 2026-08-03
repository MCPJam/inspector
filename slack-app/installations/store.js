/**
 * Bolt `InstallationStore` backed by the MCPJam backend.
 *
 * Bolt derives its `authorize` from this store when OAuth installer options
 * are supplied (`App.js` refuses BOTH a custom `authorize` and installer
 * options, so this is the only place workspace credentials may come from).
 * Every inbound event therefore passes through `fetchInstallation`.
 *
 * CACHE. A backend round-trip per event would put a network hop on the 3-second
 * ack budget, so successful lookups are cached in-process for a few minutes.
 * The cache is only safe because it is BUSTED SYNCHRONOUSLY by the lifecycle
 * events — `app_uninstalled`, a bot-token `tokens_revoked`, and reinstall all
 * call `purgeInstallation()` before their handler returns. Without that, a
 * revoked workspace would keep being served from cache for the full TTL, and
 * "revocation is instant" would be a lie. Negative results are NOT cached: a
 * workspace that installs seconds after a miss must work immediately.
 *
 * REPLICA SCOPE. This cache and its purge are process-local. The Railway
 * service is pinned to ONE replica (see railway.toml) precisely because of
 * that: with two replicas, a purge on replica A would leave replica B serving
 * a revoked token until its own TTL lapsed. Shared invalidation is deferred
 * until we actually need horizontal scale.
 */
import { fetchInstallationRecord, InstallationBackendError, storeInstallationRecord } from './backend-client.js';

/**
 * Five minutes. Long enough to take the backend off the hot path for a busy
 * thread, short enough that even a MISSED lifecycle event (Slack drops one,
 * the process restarts mid-handler) self-heals quickly instead of pinning a
 * stale token for hours.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** @typedef {import('./backend-client.js').StoredInstallationRecord} StoredInstallationRecord */

/** @type {Map<string, { record: StoredInstallationRecord, expiresAt: number }>} */
const cache = new Map();

/**
 * Drop a workspace's cached credentials NOW. Called by the lifecycle
 * listeners; making revocation synchronous here is what makes it honest.
 * @param {string} teamId
 */
export function purgeInstallation(teamId) {
  cache.delete(teamId);
}

/** Test helper. */
export function clearInstallationCache() {
  cache.clear();
}

/** Test helper: observe cache occupancy without exposing tokens. */
export function installationCacheSize() {
  return cache.size;
}

/**
 * Read through the cache. Throws (never returns null) when the backend could
 * not be reached — see `fetchInstallationRecord`.
 * @param {string} teamId
 * @returns {Promise<StoredInstallationRecord | null>}
 */
export async function resolveInstallation(teamId) {
  const hit = cache.get(teamId);
  if (hit && hit.expiresAt > Date.now()) return hit.record;
  // An expired entry is dropped before the fetch so a failing backend cannot
  // keep serving a stale token past its TTL.
  if (hit) cache.delete(teamId);

  const record = await fetchInstallationRecord(teamId);
  if (record) {
    cache.set(teamId, { record, expiresAt: Date.now() + CACHE_TTL_MS });
  }
  return record;
}

/**
 * Bolt calls this with a `Query` object. We reject enterprise-install queries
 * outright rather than resolving them against a team row: `org_deploy_enabled`
 * is off, so an enterprise-install query means either a misconfiguration or an
 * install shape we do not support, and answering it with SOME workspace's
 * token would be acting as a tenant nobody authorized.
 *
 * @param {{ teamId?: string, enterpriseId?: string, isEnterpriseInstall?: boolean }} query
 */
function resolveQueryTeamId(query) {
  if (query.isEnterpriseInstall) {
    throw new Error('Org-wide (enterprise grid) installs are not supported. Install MCPJam per workspace.');
  }
  if (!query.teamId) {
    throw new Error('Installation query carried no teamId.');
  }
  return query.teamId;
}

/**
 * Extract the queryable fields Bolt's `Installation` carries. Kept narrow on
 * purpose — the backend stores the whole object, so anything not listed here
 * still survives the round trip; these are only the columns we index or show.
 * @param {Record<string, any>} installation
 */
function describeInstallation(installation) {
  const teamId = installation?.team?.id;
  const botUserId = installation?.bot?.userId;
  if (!teamId) throw new Error('Slack returned an installation with no team id.');
  if (!botUserId) {
    // Without the bot user id the app cannot tell its OWN messages apart from
    // a human's when re-reading a thread, so every turn would feed the model
    // its own replies as user input.
    throw new Error('Slack returned an installation with no bot user id.');
  }
  return {
    teamId: String(teamId),
    teamName: String(installation?.team?.name ?? teamId),
    appId: String(installation?.appId ?? ''),
    botUserId: String(botUserId),
    scopes: Array.isArray(installation?.bot?.scopes) ? installation.bot.scopes.map(String) : [],
    ...(installation?.enterprise?.id ? { enterpriseId: String(installation.enterprise.id) } : {}),
  };
}

/**
 * The object handed to Bolt's `App({ installationStore })`.
 * @type {import('@slack/oauth').InstallationStore}
 */
export const convexInstallationStore = {
  /**
   * @param {any} installation
   * @param {any} [_options]
   * @param {any} [logger]
   */
  storeInstallation: async (installation, _options, logger) => {
    if (installation?.isEnterpriseInstall) {
      throw new Error('Org-wide (enterprise grid) installs are not supported. Install MCPJam per workspace.');
    }
    const described = describeInstallation(installation);
    await storeInstallationRecord({ ...described, installation });
    // A reinstall changes the token. Anything cached for this workspace is
    // now the PREVIOUS grant, so drop it before the next event arrives.
    purgeInstallation(described.teamId);
    logger?.info?.(`Stored Slack installation for team ${described.teamId}`);
  },

  /**
   * @param {any} query
   * @param {any} [_options]
   * @param {any} [logger]
   */
  fetchInstallation: async (query, _options, logger) => {
    const teamId = resolveQueryTeamId(query);
    let record;
    try {
      record = await resolveInstallation(teamId);
    } catch (error) {
      // Surface backend outages as errors, not as "not installed". Bolt turns
      // a throw into a failed authorization and the event is retried by Slack;
      // returning null would look like an uninstall and silently drop it.
      if (error instanceof InstallationBackendError) {
        logger?.error?.(`Installation lookup failed for team ${teamId}: ${error.message}`);
      }
      throw error;
    }
    if (!record) {
      throw new Error(`No active MCPJam installation for team ${teamId}.`);
    }
    return /** @type {any} */ (record.installation);
  },

  /**
   * @param {any} query
   * @param {any} [_options]
   * @param {any} [logger]
   */
  deleteInstallation: async (query, _options, logger) => {
    const teamId = resolveQueryTeamId(query);
    // The revoke itself is driven by the lifecycle listeners (they know
    // whether a `tokens_revoked` actually named OUR bot token). Bolt only
    // calls this on its own uninstall path; keep the cache honest either way.
    purgeInstallation(teamId);
    logger?.info?.(`Purged cached Slack installation for team ${teamId}`);
  },
};
