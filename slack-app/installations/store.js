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

/**
 * Hard bound. A public app can be installed by unboundedly many workspaces,
 * and a missed lifecycle event leaves an entry nobody ever looks up again —
 * so the TTL alone does not bound retained state.
 */
const CACHE_MAX_ENTRIES = 5000;

/** @type {Map<string, { record: StoredInstallationRecord, expiresAt: number, generation: number }>} */
const cache = new Map();

/**
 * Per-team generation counter.
 *
 * A purge that lands WHILE a fetch is in flight would otherwise be undone by
 * that fetch's `cache.set`, re-inserting the revoked grant for a full TTL. The
 * counter makes the race detectable: a fetch records the generation it started
 * under and declines to cache if a purge bumped it in the meantime.
 *
 * @type {Map<string, number>}
 */
const generations = new Map();

/** @param {string} teamId */
function currentGeneration(teamId) {
  return generations.get(teamId) ?? 0;
}

/**
 * Drop a workspace's cached credentials NOW. Called by the lifecycle
 * listeners; making revocation synchronous here is what makes it honest.
 * @param {string} teamId
 */
export function purgeInstallation(teamId) {
  cache.delete(teamId);
  // Invalidate any lookup already in flight for this team.
  generations.set(teamId, currentGeneration(teamId) + 1);
  pruneGenerations();
}

/**
 * Teams with a backend lookup in flight right now.
 *
 * A counted set, not a flag: two events for the same workspace can be resolving
 * at once, and the first to finish must not un-pin the second.
 *
 * @type {Map<string, number>}
 */
const inflightLookups = new Map();

/** @param {string} teamId */
function beginLookup(teamId) {
  inflightLookups.set(teamId, (inflightLookups.get(teamId) ?? 0) + 1);
}

/** @param {string} teamId */
function endLookup(teamId) {
  const remaining = (inflightLookups.get(teamId) ?? 1) - 1;
  if (remaining > 0) {
    inflightLookups.set(teamId, remaining);
    return;
  }
  inflightLookups.delete(teamId);
  // Prune again now that this team is unpinned. A prune that ran while the
  // lookup was in flight had to skip it, so the map can still be over its
  // bound; without this it would stay there until the next purge, which on a
  // quiet deployment may be a long time.
  pruneGenerations();
}

/**
 * Bound the generation map.
 *
 * Every purge adds a permanent entry, so a public app accumulates one per
 * workspace that has ever uninstalled — unbounded state driven by strangers.
 * Dropping an entry only resets that team's counter to 0, and the ONLY thing a
 * counter must do is differ from the value an in-flight lookup recorded.
 *
 * That is why the two skips below are not decoration. A team being LOOKED UP
 * has its recorded generation compared on the way out: prune its entry and the
 * counter restarts at 0, the comparison fails, and a legitimately installed
 * workspace reads as "not installed" for that one event. Pinning it costs a map
 * lookup and removes the false negative entirely.
 *
 * What eviction can never do — in either case — is resurrect a revoked grant. A
 * real purge writes the team's entry immediately before pruning, making it the
 * NEWEST entry, and this walks oldest-first.
 */
const GENERATIONS_MAX_ENTRIES = 5000;

function pruneGenerations() {
  if (generations.size <= GENERATIONS_MAX_ENTRIES) return;
  // Insertion order, so the oldest purges go first.
  const excess = generations.size - GENERATIONS_MAX_ENTRIES;
  let dropped = 0;
  for (const teamId of generations.keys()) {
    if (dropped >= excess) break;
    // Live state, both of them: a cached record carries the generation it was
    // stored under, and an in-flight lookup is holding one to compare against.
    if (cache.has(teamId) || inflightLookups.has(teamId)) continue;
    generations.delete(teamId);
    dropped += 1;
  }
}

/** Test helper. */
export function clearInstallationCache() {
  cache.clear();
  generations.clear();
  inflightLookups.clear();
}

/**
 * Drop expired entries, then oldest-first down to the bound. Called on write,
 * so the map is swept by the same traffic that grows it.
 */
function evictIfNeeded() {
  const now = Date.now();
  for (const [teamId, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(teamId);
  }
  if (cache.size <= CACHE_MAX_ENTRIES) return;
  const byExpiry = [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (const [teamId] of byExpiry.slice(0, cache.size - CACHE_MAX_ENTRIES)) {
    cache.delete(teamId);
  }
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

  const startedAtGeneration = currentGeneration(teamId);
  // Pin the generation entry for the duration of the fetch. Without this, an
  // unrelated team's purge could prune it mid-flight, reset the counter to 0,
  // and make the check below refuse a workspace that is perfectly installed.
  beginLookup(teamId);
  try {
    const record = await fetchInstallationRecord(teamId);

    // A purge or reinstall landed while this lookup was in flight, so the
    // answer we are holding describes a grant that has since been revoked or
    // replaced. RETURNING it is the harm, not caching it: Bolt would authorize
    // this event with a token the workspace just killed. Refusing reads as "not
    // installed", which is the correct answer for a revoked install and a
    // safely retryable one for a reinstall — the next event re-fetches under
    // the new generation.
    //
    // Inside the `try` on purpose: the comparison is only meaningful while the
    // generation entry is still pinned.
    if (currentGeneration(teamId) !== startedAtGeneration) return null;

    if (record) {
      cache.set(teamId, {
        record,
        expiresAt: Date.now() + CACHE_TTL_MS,
        generation: startedAtGeneration,
      });
      evictIfNeeded();
    }
    return record;
  } finally {
    endLookup(teamId);
  }
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
   * Bolt calls this with (installation, options) — there is no third `logger`
   * argument, so diagnostics go through the module logger instead of a
   * parameter that would always be undefined.
   * @param {any} installation
   * @param {any} [_options]
   */
  storeInstallation: async (installation, _options) => {
    if (installation?.isEnterpriseInstall) {
      throw new Error('Org-wide (enterprise grid) installs are not supported. Install MCPJam per workspace.');
    }
    const described = describeInstallation(installation);
    await storeInstallationRecord({ ...described, installation });
    // A reinstall changes the token. Anything cached for this workspace is
    // now the PREVIOUS grant, so drop it before the next event arrives.
    purgeInstallation(described.teamId);
    console.info(`[slack-installations] stored installation for team ${described.teamId}`);
  },

  /**
   * @param {any} query
   * @param {any} [_options]
   */
  fetchInstallation: async (query, _options) => {
    const teamId = resolveQueryTeamId(query);
    let record;
    try {
      record = await resolveInstallation(teamId);
    } catch (error) {
      // Surface backend outages as errors, not as "not installed". Bolt turns
      // a throw into a failed authorization and the event is retried by Slack;
      // returning null would look like an uninstall and silently drop it.
      if (error instanceof InstallationBackendError) {
        console.error(`[slack-installations] lookup failed for team ${teamId}: ${error.message}`);
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
   */
  deleteInstallation: async (query, _options) => {
    const teamId = resolveQueryTeamId(query);
    // The revoke itself is driven by the lifecycle listeners (they know
    // whether a `tokens_revoked` actually named OUR bot token). Bolt only
    // calls this on its own uninstall path; keep the cache honest either way.
    purgeInstallation(teamId);
    console.info(`[slack-installations] purged cached installation for team ${teamId}`);
  },
};
