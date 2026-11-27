import type { Result, Server } from "@modelcontextprotocol/server";
import { forwardToReal } from "./item-handlers.js";
import type { ItemHandlerContext } from "./item-handlers.js";
import { planResourceRead } from "./resolve-items.js";

/**
 * `resources/subscribe` and `resources/unsubscribe` (2025-era revisions;
 * 2026-07-28 replaced them with `subscriptions/listen`). A resource of the
 * real server is passed through after the host allows it. A resource the mock
 * owns is acknowledged with nothing to register: the mock keeps no session, so
 * an update reaches a client only on the stream of the call that announced it
 * (a saved case's `resourceUpdated` step).
 */
export function registerSubscribeHandlers(
  server: Server,
  c: ItemHandlerContext
): void {
  for (const method of [
    "resources/subscribe",
    "resources/unsubscribe",
  ] as const) {
    server.setRequestHandler(method, async (request, ctx) => {
      const { uri } = request.params;
      const own = planResourceRead(c.definition, uri).kind === "own";
      if (own || !c.realCapabilities.resources?.subscribe) return {};
      return (await forwardToReal(
        c,
        method,
        { uri },
        ctx.mcpReq.signal
      )) as Result;
    });
  }
}
