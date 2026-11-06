/**
 * Per-IP budget for share-card backend lookups.
 *
 * The card route is public, and a token it has not seen recently costs a
 * backend read. Without a budget, a caller inventing tokens turns every
 * request into one. Only those lookups are charged: a card already in the
 * cache is free, so a crawler re-fetching a popular link never runs dry.
 *
 * The budget is per IP and generous, because the crawlers that unfurl links
 * (Twitterbot, LinkedInBot, Slackbot, Discordbot) fetch many different links
 * from a small pool of addresses. Same shape as the score route's limiter:
 * fixed windows, swept on a timer, and a memory cap that fails closed.
 */

export const SHARE_CARD_LOOKUP_LIMIT = 120;
export const SHARE_CARD_LOOKUP_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRACKED_CLIENTS = 10_000;

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

/** Spends one lookup for `clientKey`. False when its budget is gone. */
export function admitShareCardLookup(
  clientKey: string,
  now = Date.now(),
): boolean {
  const window = windows.get(clientKey);
  if (window) {
    if (now - window.windowStart >= SHARE_CARD_LOOKUP_WINDOW_MS) {
      window.count = 1;
      window.windowStart = now;
      return true;
    }
    if (window.count >= SHARE_CARD_LOOKUP_LIMIT) return false;
    window.count++;
    return true;
  }
  // Fail closed rather than evict: evicting would hand a churner a fresh
  // allowance just for filling the map.
  if (windows.size >= MAX_TRACKED_CLIENTS) return false;
  windows.set(clientKey, { count: 1, windowStart: now });
  return true;
}

/** Test seam. */
export function resetShareCardLookupLimit(): void {
  windows.clear();
}
