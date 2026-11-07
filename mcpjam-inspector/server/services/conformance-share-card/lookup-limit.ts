/**
 * Per-client budget for share-card backend lookups.
 *
 * The card route is public, and a token it has not seen recently costs a
 * backend read. Without a budget, a caller inventing tokens turns every
 * request into one. Only those lookups are charged: a card already in the
 * cache is free, so a crawler re-fetching a popular link never runs dry.
 *
 * Only an address this deployment can vouch for (`getAttestedClientIp`) gets
 * a window of its own. Everything else shares one pooled window, because a
 * key the caller can rotate is a way to fill the map, not a way to bound
 * anyone (same rule as routes/web/bench.ts). The budgets are generous: the
 * crawlers that unfurl links (Twitterbot, LinkedInBot, Slackbot, Discordbot)
 * fetch many different links from a small pool of addresses.
 */

export const SHARE_CARD_LOOKUP_LIMIT = 120;
/** One window for every caller we cannot place, so it bounds a population. */
export const SHARE_CARD_POOLED_LOOKUP_LIMIT = 600;
export const SHARE_CARD_LOOKUP_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED_CLIENTS = 10_000;
const POOLED_KEY = "_pooled";

const windows = new Map<string, { count: number; windowStart: number }>();

// Expire on a timer, not on the request: sweeping inside the handler would
// make every public request pay for the whole table.
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of windows) {
    if (now - value.windowStart >= SHARE_CARD_LOOKUP_WINDOW_MS) {
      windows.delete(key);
    }
  }
}, 60_000).unref();

function spend(key: string, limit: number, now: number): boolean {
  const window = windows.get(key);
  if (!window) {
    windows.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (now - window.windowStart >= SHARE_CARD_LOOKUP_WINDOW_MS) {
    window.count = 1;
    window.windowStart = now;
    return true;
  }
  if (window.count >= limit) return false;
  window.count++;
  return true;
}

/**
 * Spends one lookup. `attestedIp` is the caller's vouched-for address, or
 * null. False when the budget it draws on is gone.
 */
export function admitShareCardLookup(
  attestedIp: string | null,
  now = Date.now(),
): boolean {
  // A full table does not refuse a new address and does not evict one (that
  // would hand its owner a fresh allowance): the newcomer draws on the pool,
  // so the limit still holds and nobody is locked out.
  const ownWindow =
    attestedIp !== null &&
    (windows.has(attestedIp) || windows.size < MAX_TRACKED_CLIENTS);
  return ownWindow
    ? spend(attestedIp, SHARE_CARD_LOOKUP_LIMIT, now)
    : spend(POOLED_KEY, SHARE_CARD_POOLED_LOOKUP_LIMIT, now);
}

/** Test seam. */
export function resetShareCardLookupLimit(): void {
  windows.clear();
}
