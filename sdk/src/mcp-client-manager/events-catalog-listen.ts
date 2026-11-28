import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import { EventsListChangedNotificationMethod } from "./events-ext.js";
import type { ManagedMcpClient } from "./managed-mcp-client.js";
import {
  SUBSCRIPTION_ID_META_KEY,
  SubscriptionCoordinator,
  SubscriptionsAcknowledgedNotificationMethod,
  type SubscriptionFilterShape,
} from "./subscription-coordinator.js";

type Notification = { method: string; params?: Record<string, unknown> };
type Handler = (notification: Notification) => void;
type PendingListen = { onAcknowledged: Handler; id?: string };

function subscriptionId(params: Notification["params"]): unknown {
  const meta = params?._meta;
  return typeof meta === "object" && meta !== null && SUBSCRIPTION_ID_META_KEY in meta
    ? meta[SUBSCRIPTION_ID_META_KEY]
    : undefined;
}

/** The upstream core codec consumes the ACK and strips extension filter fields. */
export class CatalogListenCapture {
  private readonly pendingFilters = new WeakMap<object, PendingListen>();
  private readonly pendingIds = new Map<string, PendingListen>();
  private readonly connection = new AbortController();

  get signal(): AbortSignal {
    return this.connection.signal;
  }

  close(): void {
    this.connection.abort();
  }

  async listen<T>(filter: SubscriptionFilterShape, open: () => Promise<T>, onAcknowledged: Handler): Promise<T> {
    const pending: PendingListen = { onAcknowledged };
    this.pendingFilters.set(filter, pending);
    try {
      return await open();
    } finally {
      this.pendingFilters.delete(filter);
      if (pending.id !== undefined) this.pendingIds.delete(pending.id);
    }
  }

  send(message: JSONRPCMessage): void {
    if (!("method" in message) || message.method !== "subscriptions/listen" ||
        !("id" in message) || typeof message.id !== "string") return;
    const filter = message.params?.notifications;
    if (typeof filter !== "object" || filter === null) return;
    const pending = this.pendingFilters.get(filter);
    if (pending) {
      pending.id = message.id;
      this.pendingIds.set(message.id, pending);
    }
  }

  receive(message: JSONRPCMessage): void {
    if (!("method" in message) || message.method !== SubscriptionsAcknowledgedNotificationMethod) return;
    const id = subscriptionId(message.params);
    if (typeof id !== "string") return;
    const pending = this.pendingIds.get(id);
    if (!pending) return;
    this.pendingIds.delete(id);
    pending.onAcknowledged({ method: message.method, params: message.params });
  }
}

/** Watch one connected Events catalog for the caller's lifetime. */
export async function watchEventsCatalog(
  client: ManagedMcpClient,
  capture: CatalogListenCapture,
  options: {
    signal: AbortSignal;
    subscribe: (handler: Handler) => () => void;
    onChange: () => void;
    onReady?: () => void;
  },
): Promise<void> {
  const listen = client.listen?.bind(client);
  if (!listen) return;
  const signal = AbortSignal.any([options.signal, capture.signal]);
  if (signal.aborted) return;

  const finished = new AbortController();
  const done = AbortSignal.any([signal, finished.signal]);
  let acknowledged: Handler | undefined;
  let unsubscribe: (() => void) | undefined;
  let activeId: unknown;
  const coordinator = new SubscriptionCoordinator({
    era: "modern",
    reconnect: { maxAttempts: 0 },
    client: {
      supportsEventsListChanged: () => true,
      getServerCapabilities: () => client.getServerCapabilities(),
      subscribeResource: (params) => client.subscribeResource(params),
      unsubscribeResource: (params) => client.unsubscribeResource(params),
      setNotificationHandler(method, handler) {
        if (method === SubscriptionsAcknowledgedNotificationMethod) acknowledged = handler;
        if (method === EventsListChangedNotificationMethod) {
          unsubscribe = options.subscribe((notification) => {
            if (!signal.aborted && activeId !== undefined && subscriptionId(notification.params) === activeId) {
              handler(notification);
            }
          });
        }
      },
      listen: (filter) => capture.listen(filter, () => listen(filter, { signal }), (notification) => {
        activeId = subscriptionId(notification.params);
        acknowledged?.(notification);
      }),
    },
    onStreamChange(stream) {
      if (stream.status === "opening") return;
      if (stream.status === "active" && stream.acknowledgedFilter?.eventsListChanged === true) {
        if (!signal.aborted) options.onReady?.();
      } else {
        activeId = undefined;
        finished.abort();
      }
    },
    onNotification: options.onChange,
  });
  try {
    await coordinator.setDesiredInterests({ eventsListChanged: true });
    if (!done.aborted) {
      await new Promise<void>((resolve) => done.addEventListener("abort", () => resolve(), { once: true }));
    }
  } finally {
    unsubscribe?.();
    await coordinator.dispose();
  }
}
