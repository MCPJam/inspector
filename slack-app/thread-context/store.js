/**
 * @typedef {Object} StoreEntry
 * @property {string} sessionId
 * @property {number} timestamp
 */

/**
 * In-memory session ID store with TTL-based cleanup.
 *
 * Keys are `team:channel:thread`. The team id is NOT decorative: Slack
 * channel ids are unique only within a workspace, so a two-tenant key space
 * without it lets one workspace's engaged thread mark another's as engaged —
 * the bot would answer unaddressed messages in a channel it was never
 * mentioned in. The map is also bounded by `maxEntries`, which without a
 * tenant prefix would let a busy workspace evict a quiet one's threads.
 */
export class SessionStore {
  /**
   * @param {number} [ttlSeconds=86400]
   * @param {number} [maxEntries=1000]
   */
  constructor(ttlSeconds = 86400, maxEntries = 1000) {
    /** @type {Map<string, StoreEntry>} */
    this._store = new Map();
    /** @private @type {number} */
    this._ttlSeconds = ttlSeconds;
    /** @private @type {number} */
    this._maxEntries = maxEntries;
  }

  /**
   * @private
   * @param {string} teamId
   * @param {string} channelId
   * @param {string} threadTs
   */
  _key(teamId, channelId, threadTs) {
    if (!teamId) {
      throw new Error('SessionStore requires a teamId — thread state is per-workspace.');
    }
    return `${teamId}:${channelId}:${threadTs}`;
  }

  /**
   * @param {string} teamId
   * @param {string} channelId
   * @param {string} threadTs
   * @returns {string | null}
   */
  getSession(teamId, channelId, threadTs) {
    const key = this._key(teamId, channelId, threadTs);
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this._ttlSeconds * 1000) {
      this._store.delete(key);
      return null;
    }
    return entry.sessionId;
  }

  /**
   * @param {string} teamId
   * @param {string} channelId
   * @param {string} threadTs
   * @param {string} sessionId
   * @returns {void}
   */
  setSession(teamId, channelId, threadTs, sessionId) {
    const key = this._key(teamId, channelId, threadTs);
    this._store.set(key, {
      sessionId,
      timestamp: Date.now(),
    });
    this._cleanup();
  }

  /**
   * Drop every thread belonging to one workspace. Called on uninstall: the
   * app must not keep acting on a team that revoked it, and a later reinstall
   * should start from a clean slate rather than resuming half-remembered
   * conversations.
   * @param {string} teamId
   * @returns {void}
   */
  clearTeam(teamId) {
    const prefix = `${teamId}:`;
    for (const key of [...this._store.keys()]) {
      if (key.startsWith(prefix)) this._store.delete(key);
    }
  }

  /**
   * @private
   * @returns {void}
   */
  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (now - entry.timestamp > this._ttlSeconds * 1000) {
        this._store.delete(key);
      }
    }
    if (this._store.size > this._maxEntries) {
      const sorted = [...this._store.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = sorted.slice(0, this._store.size - this._maxEntries);
      for (const [key] of toRemove) {
        this._store.delete(key);
      }
    }
  }
}
