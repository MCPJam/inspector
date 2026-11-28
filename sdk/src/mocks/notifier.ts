import type {
  ServerContext,
  ServerNotifier,
} from "@modelcontextprotocol/server";
import type { MockListKind } from "./definition-types.js";

const LIST_CHANGED_METHODS: Record<MockListKind, string> = {
  tools: "notifications/tools/list_changed",
  prompts: "notifications/prompts/list_changed",
  resources: "notifications/resources/list_changed",
};

/** Sends the change notifications a mock raises, where the caller's revision wants them. */
export interface MockNotifier {
  listChanged(list: MockListKind): Promise<void>;
  resourceUpdated(uri: string): Promise<void>;
}

/**
 * 2026-07-28 delivers list changes and resource updates only on a
 * `subscriptions/listen` stream, so they go to the handler's event bus (a
 * stream open on the same handler or bus hears them). A 2025-era revision
 * sends them as notifications on the stream of the request that raised them.
 * `ctx` is absent for a task that runs after its request ended: on a 2025-era
 * connection there is nowhere left to send, and the notification is dropped.
 */
export function notifierFor(
  era: "legacy" | "modern",
  bus: () => ServerNotifier,
  ctx?: ServerContext
): MockNotifier {
  if (era === "modern") {
    return {
      listChanged: async (list) => {
        const notify = bus();
        if (list === "tools") notify.toolsChanged();
        else if (list === "prompts") notify.promptsChanged();
        else notify.resourcesChanged();
      },
      resourceUpdated: async (uri) => bus().resourceUpdated(uri),
    };
  }
  return {
    listChanged: async (list) =>
      ctx?.mcpReq.notify({ method: LIST_CHANGED_METHODS[list] }),
    resourceUpdated: async (uri) =>
      ctx?.mcpReq.notify({
        method: "notifications/resources/updated",
        params: { uri },
      }),
  };
}
