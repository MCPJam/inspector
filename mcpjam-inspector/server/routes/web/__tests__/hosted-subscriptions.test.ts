import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  McpSubscriptionHandle,
  SubscriptionClientPort,
  SubscriptionFilterShape,
} from "@mcpjam/sdk";
import { SUBSCRIPTION_ID_META_KEY } from "@mcpjam/sdk";
import type { HostedSubscriptionEvent } from "@/shared/hosted-subscription.js";

// Mock the heavy authorize/connect helper so route-level tests never touch
// Convex/MCP. `projectServerSchema` (also imported by the route) stays real.
vi.mock("../auth.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, createManualHostedConnection: vi.fn() };
});

// Stub the PostHog capture so we can assert on its arguments.
vi.mock("../../../utils/analytics.js", () => ({
  captureServerEvent: vi.fn(),
}));

const {
  driveHostedSubscription,
  runHostedSubscriptionSession,
  acquireSubscriptionStreamSlot,
  releaseSubscriptionStreamSlot,
  activeSubscriptionStreamCount,
  resetSubscriptionStreamSlots,
  MAX_CONCURRENT_SUBSCRIPTION_STREAMS,
  default: subscriptionsRouter,
} = await import("../subscriptions.js");
const { createManualHostedConnection } = await import("../auth.js");
const { captureServerEvent } = await import("../../../utils/analytics.js");
const { WebRouteError, ErrorCode } = await import("../errors.js");

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type NotificationHandler = (n: {
  method: string;
  params?: Record<string, unknown>;
}) => void;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A fake MODERN `SubscriptionClientPort` whose `listen()` resolves to a handle
 * we control: `close` is spied, `closed` is a deferred the test resolves to
 * drive graceful/remote/local closure.
 */
function makeFakeModernClient(opts?: { subscriptionId?: string }) {
  const handlers = new Map<string, NotificationHandler>();
  const closed = deferred<"local" | "graceful" | "remote">();
  const close = vi.fn(async () => {});
  const honoredFilter: SubscriptionFilterShape = { toolsListChanged: true };
  const handle: McpSubscriptionHandle = {
    honoredFilter,
    close,
    closed: closed.promise,
    ...(opts?.subscriptionId ? { subscriptionId: opts.subscriptionId } : {}),
  };
  const listen = vi.fn(async () => handle);

  const client: SubscriptionClientPort = {
    getServerCapabilities: () => ({
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
    }),
    getProtocolEra: () => "modern",
    setNotificationHandler: (method, handler) =>
      handlers.set(method, handler as NotificationHandler),
    subscribeResource: async () => ({}),
    unsubscribeResource: async () => ({}),
    listen,
  };

  const emit = (method: string, params?: Record<string, unknown>) =>
    handlers.get(method)?.({ method, params });

  return { client, handle, close, listen, closed, emit };
}

function makeSink() {
  const events: HostedSubscriptionEvent[] = [];
  const closeSpy = vi.fn();
  const sink = {
    send: (e: HostedSubscriptionEvent) => events.push(e),
    close: closeSpy,
  };
  return { sink, events, closeSpy };
}

async function flush() {
  // Let the coordinator's internal microtask queue (reconcile → listen → ack)
  // settle.
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  resetSubscriptionStreamSlots();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Driver: open → ack → notification → terminal
// ---------------------------------------------------------------------------

describe("driveHostedSubscription", () => {
  it("emits open, forwards the acknowledgement, then a notification with its subscription id", async () => {
    const { client, emit } = makeFakeModernClient({ subscriptionId: "sub-1" });
    const { sink, events } = makeSink();

    driveHostedSubscription({
      client,
      serverId: "srv",
      desired: { toolsListChanged: true },
      sink,
    });
    await flush();

    const open = events.find((e) => e.type === "open");
    expect(open).toMatchObject({
      type: "open",
      serverId: "srv",
      era: "modern",
      supportsListen: true,
    });

    // The active stream event carries the acknowledged filter (= the ack).
    const active = events.find(
      (e) => e.type === "stream" && e.stream.status === "active",
    );
    expect(active).toBeDefined();
    expect(
      active?.type === "stream" ? active.stream.acknowledgedFilter : undefined,
    ).toMatchObject({ toolsListChanged: true });

    // Now a real notification, stamped with the subscription id.
    emit("notifications/tools/list_changed", {
      _meta: { [SUBSCRIPTION_ID_META_KEY]: "sub-1" },
    });
    await flush();

    const notif = events.find((e) => e.type === "notification");
    expect(notif).toMatchObject({
      type: "notification",
      serverId: "srv",
      notification: { kind: "tools-list-changed", subscriptionId: "sub-1" },
    });
  });

  it("closes with a GRACEFUL structured terminal event when the server completes", async () => {
    const { client, closed } = makeFakeModernClient({ subscriptionId: "s" });
    const { sink, events } = makeSink();

    const { done } = driveHostedSubscription({
      client,
      serverId: "srv",
      desired: { toolsListChanged: true },
      sink,
    });
    await flush();

    closed.resolve("graceful");
    const info = await done;

    expect(info.reason).toBe("graceful");
    const terminal = events.find((e) => e.type === "terminal");
    expect(terminal).toMatchObject({ type: "terminal", reason: "graceful" });
  });

  it("closes with a REMOTE terminal event on unexpected loss — distinct from graceful", async () => {
    const { client, closed } = makeFakeModernClient({ subscriptionId: "s" });
    const { sink, events } = makeSink();

    const { done } = driveHostedSubscription({
      client,
      serverId: "srv",
      desired: { toolsListChanged: true },
      sink,
    });
    await flush();

    closed.resolve("remote");
    const info = await done;

    expect(info.reason).toBe("remote");
    const terminal = events.find((e) => e.type === "terminal");
    expect(terminal).toMatchObject({ type: "terminal", reason: "remote" });
    // maxAttempts:0 → no server-side re-listen; the browser reopens instead.
    expect(info.reconnectAttempt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Session: abort cancels upstream + disposes the manager in finally
// ---------------------------------------------------------------------------

describe("runHostedSubscriptionSession", () => {
  it("browser abort cancels the upstream stream and disposes the manager in finally", async () => {
    const { client, close } = makeFakeModernClient({ subscriptionId: "s" });
    const disconnectAllServers = vi.fn(async () => {});
    const manager = {
      getManagedClient: () => client as never,
      disconnectAllServers,
    };
    const { sink, closeSpy } = makeSink();
    const controller = new AbortController();

    const session = runHostedSubscriptionSession({
      manager,
      serverId: "srv",
      desired: { toolsListChanged: true },
      sink,
      signal: controller.signal,
    });
    await flush();

    controller.abort();
    const info = await session;

    expect(info.reason).toBe("local-abort");
    expect(close).toHaveBeenCalled(); // upstream listen cancelled
    expect(disconnectAllServers).toHaveBeenCalled(); // disposed in finally
    expect(closeSpy).toHaveBeenCalled(); // downstream sink closed
  });

  it("captures a PostHog open event with NO notification payload", async () => {
    const { client, emit, closed } = makeFakeModernClient({
      subscriptionId: "s",
    });
    const disconnectAllServers = vi.fn(async () => {});
    const manager = {
      getManagedClient: () => client as never,
      disconnectAllServers,
    };
    const { sink } = makeSink();
    const captureOpen = vi.fn();
    const recordClosed = vi.fn();

    const session = runHostedSubscriptionSession({
      manager,
      serverId: "srv",
      desired: { toolsListChanged: true },
      sink,
      seams: { captureOpen, recordClosed },
    });
    await flush();

    // A notification arrives while the stream is live...
    emit("notifications/tools/list_changed", {
      _meta: { [SUBSCRIPTION_ID_META_KEY]: "s" },
      // a payload the analytics layer must NEVER see:
      secretPayload: { uri: "file:///secret", data: "leak" },
    });
    await flush();
    closed.resolve("graceful");
    await session;

    // The open capture carries only era/transport/support — no payload keys.
    expect(captureOpen).toHaveBeenCalledTimes(1);
    const openArg = captureOpen.mock.calls[0][0];
    expect(openArg).toEqual({
      serverId: "srv",
      era: "modern",
      supportsListen: true,
      transport: "http",
    });
    expect(JSON.stringify(captureOpen.mock.calls)).not.toContain("leak");
    expect(JSON.stringify(captureOpen.mock.calls)).not.toContain("secret");

    // The close record carries duration + reason + a COUNT, never a payload.
    expect(recordClosed).toHaveBeenCalledTimes(1);
    const closeArg = recordClosed.mock.calls[0][0];
    expect(closeArg.reason).toBe("graceful");
    expect(closeArg.notificationCount).toBe(1);
    expect(JSON.stringify(recordClosed.mock.calls)).not.toContain("leak");
  });
});

// ---------------------------------------------------------------------------
// Concurrent-stream limit
// ---------------------------------------------------------------------------

describe("concurrent-stream limit", () => {
  it("acquires up to the cap then refuses, and releases give the slot back", () => {
    const key = "actor-1";
    for (let i = 0; i < MAX_CONCURRENT_SUBSCRIPTION_STREAMS; i++) {
      expect(acquireSubscriptionStreamSlot(key)).toBe(true);
    }
    expect(activeSubscriptionStreamCount(key)).toBe(
      MAX_CONCURRENT_SUBSCRIPTION_STREAMS,
    );
    // Over the cap.
    expect(acquireSubscriptionStreamSlot(key)).toBe(false);
    // A different actor has its own bucket.
    expect(acquireSubscriptionStreamSlot("actor-2")).toBe(true);
    // Free one and it can be re-acquired.
    releaseSubscriptionStreamSlot(key);
    expect(acquireSubscriptionStreamSlot(key)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Route-level: authz mismatch fails closed; over-cap returns 429
// ---------------------------------------------------------------------------

describe("POST /listen route", () => {
  function appWithContext() {
    const { Hono } = require("hono");
    const app = new Hono();
    // Provide the request log context the route reads for the actor key.
    app.use("*", async (c: any, next: () => Promise<void>) => {
      c.set("requestLogContext", { userExternalId: "user-x" });
      await next();
    });
    app.route("/subscriptions", subscriptionsRouter);
    return app;
  }

  const body = JSON.stringify({
    projectId: "p1",
    serverId: "s1",
    desired: { toolsListChanged: true },
  });

  it("fails closed (403) when authorization is denied, and releases the slot", async () => {
    (createManualHostedConnection as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(
        new WebRouteError(403, ErrorCode.FORBIDDEN, "Authorization denied"),
      );

    const app = appWithContext();
    const res = await app.request("/subscriptions/listen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.code).toBe("FORBIDDEN");
    // Slot released — a denied request must not leak concurrency budget.
    expect(activeSubscriptionStreamCount("user-x")).toBe(0);
    expect(captureServerEvent).not.toHaveBeenCalled();
  });

  it("returns 429 when the actor is already at the concurrent-stream cap", async () => {
    for (let i = 0; i < MAX_CONCURRENT_SUBSCRIPTION_STREAMS; i++) {
      acquireSubscriptionStreamSlot("user-x");
    }

    const app = appWithContext();
    const res = await app.request("/subscriptions/listen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.code).toBe("RATE_LIMITED");
    // The over-cap request must not have attempted a connection.
    expect(createManualHostedConnection).not.toHaveBeenCalled();
  });
});
