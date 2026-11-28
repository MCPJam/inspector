import {
  fetchEventsViewerToken,
  fetchHostedEventsFeed,
  fetchLocalEventsFeed,
  loadEventsCatalog,
} from "@/lib/apis/mcp-events-api";
import type { ServerEventCatalog } from "./PlaygroundEventsProvider";

/** One server's whole catalog, every page. Errors become `error`. */
export async function loadServerCatalog(
  serverName: string,
): Promise<ServerEventCatalog> {
  try {
    const catalog = await loadEventsCatalog(serverName);
    let cursor = catalog.nextCursor;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const page = await loadEventsCatalog(serverName, cursor);
      catalog.events.push(...page.events);
      cursor = page.nextCursor;
    }
    return { serverName, catalog };
  } catch (error) {
    return {
      serverName,
      error:
        error instanceof Error
          ? error.message
          : "Could not load events. Reconnect this server and retry.",
    };
  }
}

/**
 * The feed's current end: where a new connection, or one turned back on,
 * starts listening, so it never runs what arrived before it.
 */
export async function feedWatermark(
  hosted: boolean,
  projectId: string | null,
): Promise<number> {
  const token =
    hosted && projectId ? await fetchEventsViewerToken(projectId) : null;
  let after = 0;
  for (let page = 0; page < 100; page += 1) {
    const result = token
      ? await fetchHostedEventsFeed({ ...token, after })
      : await fetchLocalEventsFeed(after, projectId);
    if (result.nextAfter <= after) return after;
    after = result.nextAfter;
    if (result.entries.length === 0) return after;
  }
  throw new Error("The event feed is busy. Wait a moment and try again.");
}
