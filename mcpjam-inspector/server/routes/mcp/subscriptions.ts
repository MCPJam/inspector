import { Hono } from "hono";
import type {
  DeliveredSubscriptionNotification,
  DesiredSubscriptionInterests,
  MCPClientManager,
  RejectedSubscriptionNotification,
  SubscriptionClientPort,
  SubscriptionStreamRecord,
} from "@mcpjam/sdk";
import { SubscriptionCoordinator } from "@mcpjam/sdk";
import type {
  SubscriptionBridgeEvent,
  SubscriptionDesiredInterestsView,
  SubscriptionNotificationView,
  SubscriptionRejectedNotificationView,
  SubscriptionServerStateView,
  SubscriptionStreamView,
} from "@/shared/subscription-bridge.js";
import { SUBSCRIPTION_BRIDGE_EVENT_LIMIT } from "@/shared/subscription-bridge.js";
import { logger } from "../../utils/logger";

/**
 * `subscriptions.ts` — the LOCAL Inspector bridge for MCP 2026-07-28
 * `subscriptions/listen` (spec §13.2).
 *
 * The upstream subscription stays where it belongs: the local
 * `MCPClientManager`'s client owns the stream, and the SDK's
 * `SubscriptionCoordinator` owns the era-neutral state machine (desired
 * interests → requested filter → acknowledged filter → stream lifecycle). This
 * route is *only* an observation channel plus a way to state desire, modelled
 * on the elicitation/MRTR SSE bridges: one shared SSE fan-out, snapshot on
 * connect, incremental events after.
 *
 * Two consequences the UI depends on:
 *
 * - **Desire, not verbs.** The browser POSTs the interests it wants; the
 *   coordinator decides whether that means `subscriptions/listen` with a new
 *   filter (modern — a listen filter is immutable, so a change is a controlled
 *   close + reopen) or per-URI `resources/subscribe` calls (legacy). The
 *   browser never issues subscription RPCs itself.
 * - **Refusals are events.** Rejected interests and rejected notifications are
 *   broadcast and retained so the UI can show the *absence* the server chose,
 *   rather than a notification quietly not arriving.
 */

// ---------------------------------------------------------------------------
// SSE fan-out (one channel for every connected server)
// ---------------------------------------------------------------------------

type Subscriber = { send: (event: unknown) => void; close: () => void };
const subscribers = new Set<Subscriber>();

function broadcast(event: SubscriptionBridgeEvent): void {
  for (const sub of Array.from(subscribers)) {
    try {
      sub.send(event);
    } catch {
      try {
        sub.close();
      } catch {}
      subscribers.delete(sub);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-manager, per-server coordinator registry
// ---------------------------------------------------------------------------

type ServerEntry = {
  serverId: string;
  coordinator: SubscriptionCoordinator;
  supportsListen: boolean;
  /** Computed once per entry — the manager's probe on the live connection. */
  supportsTaskDeclaredListen: boolean;
  desired: SubscriptionDesiredInterestsView;
  /** Local stream id → latest view. Closed streams are retained for History. */
  streams: Map<string, SubscriptionStreamView>;
  notifications: SubscriptionNotificationView[];
  rejectedNotifications: SubscriptionRejectedNotificationView[];
};

const registries = new WeakMap<MCPClientManager, Map<string, ServerEntry>>();

function registryFor(manager: MCPClientManager): Map<string, ServerEntry> {
  let registry = registries.get(manager);
  if (!registry) {
    registry = new Map();
    registries.set(manager, registry);
  }
  return registry;
}

function push<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > SUBSCRIPTION_BRIDGE_EVENT_LIMIT) {
    list.splice(0, list.length - SUBSCRIPTION_BRIDGE_EVENT_LIMIT);
  }
}

function toStreamView(stream: SubscriptionStreamRecord): SubscriptionStreamView {
  return {
    localId: stream.localId,
    era: stream.era,
    ...(stream.mcpSubscriptionId
      ? { mcpSubscriptionId: stream.mcpSubscriptionId }
      : {}),
    ...(stream.idBinding ? { idBinding: stream.idBinding } : {}),
    requestedFilter: { ...stream.requestedFilter },
    ...(stream.acknowledgedFilter
      ? { acknowledgedFilter: { ...stream.acknowledgedFilter } }
      : {}),
    rejectedInterests: stream.rejectedInterests.map((r) => ({ ...r })),
    status: stream.status,
    ...(stream.closeReason ? { closeReason: stream.closeReason } : {}),
    ...(stream.error ? { error: stream.error } : {}),
    openedAt: stream.openedAt,
    ...(stream.acknowledgedAt ? { acknowledgedAt: stream.acknowledgedAt } : {}),
    ...(stream.closedAt ? { closedAt: stream.closedAt } : {}),
    reconnectAttempt: stream.reconnectAttempt,
  };
}

function toNotificationView(
  event: DeliveredSubscriptionNotification,
): SubscriptionNotificationView {
  return {
    method: event.method,
    kind: event.kind,
    ...(event.uri ? { uri: event.uri } : {}),
    // The poll-now hint's target: the browser refreshes this task via
    // `tasks/get` — the notification params are never treated as state.
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.subscriptionId ? { subscriptionId: event.subscriptionId } : {}),
    localSubscriptionId: event.localSubscriptionId,
    at: event.at,
  };
}

function toRejectionView(
  event: RejectedSubscriptionNotification,
): SubscriptionRejectedNotificationView {
  return {
    method: event.method,
    ...(event.subscriptionId ? { subscriptionId: event.subscriptionId } : {}),
    ...(event.localSubscriptionId
      ? { localSubscriptionId: event.localSubscriptionId }
      : {}),
    reason: event.reason,
    at: event.at,
  };
}

export function toServerStateView(
  entry: ServerEntry,
): SubscriptionServerStateView {
  return {
    serverId: entry.serverId,
    era: entry.coordinator.era,
    supportsListen: entry.supportsListen,
    supportsTaskDeclaredListen: entry.supportsTaskDeclaredListen,
    desired: { ...entry.desired },
    streams: [...entry.streams.values()],
    notifications: [...entry.notifications],
    rejectedNotifications: [...entry.rejectedNotifications],
  };
}

/**
 * The coordinator's port over the managed client — explicit delegation, not a
 * cast, because the port's OPTIONAL methods are semantic: on
 * `SubscriptionClientPort`, availability is method PRESENCE. In particular
 * `listenWithTasksDeclaration` is installed ONLY when the manager's probe
 * passes; when it is absent the coordinator drops the `taskIds` selection,
 * records it as `tasks-declaration-unavailable`, and polling (always
 * sufficient) remains the only channel. A cast would have advertised a method
 * the connection cannot honor — or hidden one it could.
 */
function buildSubscriptionPort(
  manager: MCPClientManager,
  serverId: string,
  client: NonNullable<ReturnType<MCPClientManager["getManagedClient"]>>,
  supportsTaskDeclaredListen: boolean,
): SubscriptionClientPort {
  const port: SubscriptionClientPort = {
    getServerCapabilities: () => client.getServerCapabilities(),
    getProtocolEra: () => client.getProtocolEra?.(),
    setNotificationHandler: (method, handler) =>
      client.setNotificationHandler(
        method as Parameters<typeof client.setNotificationHandler>[0],
        handler as Parameters<typeof client.setNotificationHandler>[1],
      ),
    subscribeResource: (params) => client.subscribeResource(params),
    unsubscribeResource: (params) => client.unsubscribeResource(params),
    ...(typeof client.listen === "function"
      ? {
          listen: (filter: Parameters<NonNullable<typeof client.listen>>[0]) =>
            client.listen!(filter),
        }
      : {}),
  };
  if (supportsTaskDeclaredListen) {
    port.listenWithTasksDeclaration = (filter) =>
      manager.listenWithTasksDeclaration(serverId, filter);
  }
  return port;
}

/**
 * Creates (or returns) the coordinator that owns `serverId`'s subscription.
 *
 * Returns `undefined` when the server is not connected: the coordinator drives
 * a live client, and inventing one for a disconnected server would report a
 * lifecycle that no transport is backing.
 */
export function getOrCreateEntry(
  manager: MCPClientManager,
  serverId: string,
): ServerEntry | undefined {
  const registry = registryFor(manager);
  const existing = registry.get(serverId);
  if (existing) return existing;

  const client = manager.getManagedClient(serverId);
  if (!client) return undefined;

  const supportsTaskDeclaredListen =
    manager.supportsTaskDeclaredListen(serverId);
  const entry: ServerEntry = {
    serverId,
    // Assigned below; the coordinator's callbacks close over `entry`.
    coordinator: undefined as unknown as SubscriptionCoordinator,
    supportsListen: typeof client.listen === "function",
    supportsTaskDeclaredListen,
    desired: {},
    streams: new Map(),
    notifications: [],
    rejectedNotifications: [],
  };

  entry.coordinator = new SubscriptionCoordinator({
    client: buildSubscriptionPort(
      manager,
      serverId,
      client,
      supportsTaskDeclaredListen,
    ),
    onStreamChange: (stream) => {
      const view = toStreamView(stream);
      entry.streams.set(view.localId, view);
      broadcast({
        type: "subscription_stream",
        serverId,
        era: view.era,
        stream: view,
      });
    },
    onNotification: (event) => {
      const view = toNotificationView(event);
      push(entry.notifications, view);
      broadcast({
        type: "subscription_notification",
        serverId,
        notification: view,
      });
    },
    onRejectedNotification: (event) => {
      const view = toRejectionView(event);
      push(entry.rejectedNotifications, view);
      broadcast({ type: "subscription_rejected", serverId, rejection: view });
    },
  });

  registry.set(serverId, entry);
  return entry;
}

/** Snapshot of every server the bridge is currently tracking. */
export function snapshot(
  manager: MCPClientManager,
): SubscriptionServerStateView[] {
  return [...registryFor(manager).values()].map(toServerStateView);
}

/** Test seam: forget every coordinator this manager owns. */
export function resetSubscriptionRegistry(manager: MCPClientManager): void {
  registries.delete(manager);
}

function normalizeDesired(
  input: unknown,
): SubscriptionDesiredInterestsView | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const raw = input as Record<string, unknown>;
  const uris = raw.resourceUris;
  if (uris !== undefined && !Array.isArray(uris)) return undefined;
  const taskIds = raw.taskIds;
  if (taskIds !== undefined && !Array.isArray(taskIds)) return undefined;
  return {
    ...(raw.toolsListChanged !== undefined
      ? { toolsListChanged: Boolean(raw.toolsListChanged) }
      : {}),
    ...(raw.promptsListChanged !== undefined
      ? { promptsListChanged: Boolean(raw.promptsListChanged) }
      : {}),
    ...(raw.resourcesListChanged !== undefined
      ? { resourcesListChanged: Boolean(raw.resourcesListChanged) }
      : {}),
    ...(uris
      ? { resourceUris: uris.filter((u): u is string => typeof u === "string") }
      : {}),
    // Not stripped: `taskIds` is the Tasks tab's slice of the desired filter
    // (extension `notifications/tasks`). The coordinator gates it on the
    // extension capability and the declared-listen opener.
    ...(taskIds
      ? {
          taskIds: taskIds.filter((t): t is string => typeof t === "string"),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const subscriptions = new Hono();

subscriptions.get("/stream", async (c) => {
  const encoder = new TextEncoder();
  const manager = c.mcpClientManager;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: keep-alive\n\n`));
        } catch {}
      }, 25000);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAlive);
        try {
          controller.close();
        } catch {}
      };

      controller.enqueue(encoder.encode(`retry: 1500\n\n`));

      const subscriber = { send, close };
      subscribers.add(subscriber);

      // Snapshot first: a late subscriber must see streams that opened (and
      // closed) before it connected, or the History would start mid-story.
      send({
        type: "subscriptions_snapshot",
        servers: snapshot(manager),
      } satisfies SubscriptionBridgeEvent);

      c.req.raw.signal?.addEventListener?.("abort", () => {
        subscribers.delete(subscriber);
        close();
      });
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
});

subscriptions.post("/state", async (c) => {
  try {
    const { serverId } = (await c.req.json()) as { serverId?: string };
    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const entry = getOrCreateEntry(c.mcpClientManager, serverId);
    if (!entry) {
      return c.json({ success: false, error: "Server is not connected" }, 404);
    }
    return c.json({ success: true, state: toServerStateView(entry) });
  } catch (error) {
    logger.error("[subscriptions] Failed to read state", error);
    return c.json({ success: false, error: "Failed to read state" }, 400);
  }
});

/**
 * Declares the desired interests. On the modern era a changed filter closes the
 * live stream and opens a new one (a listen filter is immutable); on the legacy
 * era the coordinator issues the per-URI `resources/subscribe` RPCs instead.
 */
subscriptions.post("/desired", async (c) => {
  let serverId: string | undefined;
  try {
    const body = (await c.req.json()) as {
      serverId?: string;
      desired?: unknown;
    };
    serverId = body.serverId;
    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const desired = normalizeDesired(body.desired);
    if (!desired) {
      return c.json({ success: false, error: "desired is invalid" }, 400);
    }
    const entry = getOrCreateEntry(c.mcpClientManager, serverId);
    if (!entry) {
      return c.json({ success: false, error: "Server is not connected" }, 404);
    }
    entry.desired = desired;
    await entry.coordinator.setDesiredInterests(
      desired as DesiredSubscriptionInterests,
    );
    return c.json({ success: true, state: toServerStateView(entry) });
  } catch (error) {
    logger.error("[subscriptions] Failed to set desired interests", error, {
      serverId,
    });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

/** Explicit user teardown: ends the stream as `cancelled` / `local-abort`. */
subscriptions.post("/cancel", async (c) => {
  let serverId: string | undefined;
  try {
    const body = (await c.req.json()) as { serverId?: string };
    serverId = body.serverId;
    if (!serverId) {
      return c.json({ success: false, error: "serverId is required" }, 400);
    }
    const entry = getOrCreateEntry(c.mcpClientManager, serverId);
    if (!entry) {
      return c.json({ success: false, error: "Server is not connected" }, 404);
    }
    entry.desired = {};
    await entry.coordinator.cancel();
    return c.json({ success: true, state: toServerStateView(entry) });
  } catch (error) {
    logger.error("[subscriptions] Failed to cancel subscription", error, {
      serverId,
    });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export default subscriptions;
