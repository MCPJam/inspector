import { useTrafficLogStore } from "@/stores/traffic-log-store";
import {
  probeSerializedSize,
  truncateRpcPayload,
} from "@/shared/rpc-log-truncation";
import type { EventsFeedEntryView } from "@/shared/events-api";

const MAX_WEBHOOK_ROW_BYTES = 1024 * 1024;

/**
 * Record MCP Events feed entries in Tracing as `webhook` RECEIVE rows.
 *
 * The payload is the journal entry itself, which never holds a webhook secret
 * or a viewer token (contract C8: the inbox journals the delivery's event,
 * never its signature or headers). Rows are keyed by feed and `seq`, so a
 * backlog replayed after a reconnect or a remount upserts instead of
 * duplicating.
 */
export function logEventsFeedEntries(
  entries: readonly EventsFeedEntryView[],
  options: {
    feed: "local" | "hosted";
    resolveServer: (entry: EventsFeedEntryView) => {
      serverId: string;
      serverName?: string;
    };
  },
): void {
  // Diagnostics must never interrupt the feed.
  try {
    const store = useTrafficLogStore.getState();
    for (const entry of entries) {
      const server = options.resolveServer(entry);
      store.addMcpServerLog({
        id: `webhook:${options.feed}:${entry.seq}`,
        serverId: server.serverId,
        serverName: server.serverName,
        kind: "webhook",
        direction: "RECEIVE",
        method: `webhook ${entry.kind}`,
        timestamp: new Date(entry.receivedAt).toISOString(),
        payload: probeSerializedSize(entry, MAX_WEBHOOK_ROW_BYTES).exceeded
          ? truncateRpcPayload(entry, MAX_WEBHOOK_ROW_BYTES)
          : entry,
      });
    }
  } catch {
    // Best effort, like every other diagnostic sink.
  }
}
