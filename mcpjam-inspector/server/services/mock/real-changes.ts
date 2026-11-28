/**
 * Carries the real server's change notifications (list changed, resource
 * updated) to a mock's `subscriptions/listen` stream on 2026-07-28, where a
 * change reaches a client only on a stream it opened.
 *
 * The mock asks the real server for exactly what the caller's stream asked
 * for: a `subscriptions/listen` on a modern real connection, else the
 * per-resource `resources/subscribe` of the 2025 revisions. A real server that
 * will not take either is not an error for the caller; the stream just hears
 * nothing from it, and the reason is logged.
 */
import type { MCPClientManager, SubscriptionFilterShape } from "@mcpjam/sdk";
import { logger } from "../../utils/logger.js";
import type { MockChangeEvent } from "./event-bus.js";

const NOTIFICATIONS: Array<[string, (params: { uri?: unknown }) => MockChangeEvent | undefined]> = [
  ["notifications/tools/list_changed", () => ({ kind: "tools_list_changed" })],
  ["notifications/prompts/list_changed", () => ({ kind: "prompts_list_changed" })],
  ["notifications/resources/list_changed", () => ({ kind: "resources_list_changed" })],
  [
    "notifications/resources/updated",
    ({ uri }) => (typeof uri === "string" ? { kind: "resource_updated", uri } : undefined),
  ],
];

/** Starts the feed; the returned function stops it and never throws. */
export async function feedFromReal(args: {
  manager: Pick<
    MCPClientManager,
    "addNotificationHandler" | "removeNotificationHandler" | "getManagedClient"
  >;
  serverId: string;
  filter: SubscriptionFilterShape;
  publish: (event: MockChangeEvent) => void;
}): Promise<() => Promise<void>> {
  const { manager, serverId, filter } = args;
  const removers = NOTIFICATIONS.map(([method, toEvent]) => {
    const handler = (notification: { params?: { uri?: unknown } }) => {
      const event = toEvent(notification.params ?? {});
      if (event) args.publish(event);
    };
    manager.addNotificationHandler(serverId, method as never, handler as never);
    return () => manager.removeNotificationHandler(serverId, method as never, handler as never);
  });

  const cleanups: Array<() => Promise<unknown>> = [];
  const client = manager.getManagedClient(serverId);
  const subscribeEach = async () => {
    if (!client) return;
    for (const uri of filter.resourceSubscriptions ?? []) {
      await client.subscribeResource({ uri });
      cleanups.push(() => client.unsubscribeResource({ uri }));
    }
  };
  try {
    if (client?.listen) {
      try {
        const subscription = await client.listen(filter as never);
        cleanups.push(() => subscription.close());
      } catch {
        // A 2025-era connection has no listen stream; it takes per-resource subscriptions instead.
        await subscribeEach();
      }
    } else {
      await subscribeEach();
    }
  } catch (error) {
    logger.warn("[mock-route] the real server would not send changes to a mock's stream", {
      serverId,
      error: error instanceof Error ? error.name : typeof error,
    });
  }

  return async () => {
    removers.forEach((remove) => remove());
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        logger.debug("[mock-route] stopping a change feed failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
}
