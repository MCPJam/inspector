import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { EventsCatalogFrame } from "@/shared/events-api.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

export function streamEventCatalogChanges(
  c: Context,
  manager: MCPClientManager,
  serverId: string,
  release?: () => Promise<void>,
): Response {
  return streamSSE(c, async (output) => {
    const abort = new AbortController();
    output.onAbort(() => abort.abort());
    const signal = AbortSignal.any([
      abort.signal,
      c.req.raw.signal,
      // End hosted requests periodically so a fresh request rechecks access.
      ...(release ? [AbortSignal.timeout(60_000)] : []),
    ]);
    const send = (type: EventsCatalogFrame["type"]) => {
      void output.writeSSE({ data: JSON.stringify({ type }) }).catch(() => abort.abort());
    };
    try {
      await manager.watchEventsCatalog(serverId, {
        signal,
        onReady: () => send("ready"),
        onChange: () => send("changed"),
      });
    } catch (error) {
      if (!signal.aborted) {
        reportRouteFailure("Events catalog notification stream failed", error, {
          source: "events.catalog-changes",
          hop: "user_server_hop",
          context: { serverId },
        });
      }
    } finally {
      await release?.();
    }
  });
}
