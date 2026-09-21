import { describe, expect, it } from "vitest";
import type { ServerCapabilities } from "@modelcontextprotocol/client";
import {
  DeliveredSubscriptionNotification,
  McpSubscriptionHandle,
  RejectedSubscriptionNotification,
  SubscriptionClientPort,
  SubscriptionCoordinator,
  SubscriptionFilterShape,
  SUBSCRIPTION_ID_META_KEY,
  SubscriptionsAcknowledgedNotificationMethod,
  ToolListChangedNotificationMethod,
  resolveRequestedFilter,
} from "../src/mcp-client-manager/subscription-coordinator.js";

/**
 * Dual-era coverage for the shared subscription coordinator.
 *
 * The wire is an in-memory fixture client: on the modern era it answers
 * `listen()` with a subscription handle, emits
 * `notifications/subscriptions/acknowledged` and then change notifications,
 * each stamped with the subscription id under `SUBSCRIPTION_ID_META_KEY`; on
 * the legacy era it records `resources/subscribe` / `resources/unsubscribe`
 * calls and pushes unstamped list-changed notifications. Every case runs
 * against the real coordinator code with no transport involved.
 */

const MODERN_CAPS: ServerCapabilities = {
  tools: { listChanged: true },
  prompts: { listChanged: true },
  resources: { listChanged: true, subscribe: true },
} as ServerCapabilities;

interface FixtureListen {
  id: string;
  filter: SubscriptionFilterShape;
  /** Acknowledge with `honoredFilter`; defaults to the requested filter. */
  acknowledge: (honored?: SubscriptionFilterShape) => void;
  /** Server completed the subscription intentionally (empty listen result). */
  endGracefully: () => void;
  /** Transport dropped: no completion result. */
  dropRemotely: () => void;
  closedLocally: boolean;
}

class FixtureClient implements SubscriptionClientPort {
  readonly listens: FixtureListen[] = [];
  readonly subscribeCalls: string[] = [];
  readonly unsubscribeCalls: string[] = [];
  /** URIs whose `resources/subscribe` should fail (legacy adapter). */
  failSubscribeFor = new Set<string>();
  /** Every `listen()` call, including the ones that throw. */
  listenAttempts = 0;
  /** When set, `listen()` rejects — the server itself is unreachable. */
  failListenWith: string | undefined;
  private handlers = new Map<
    string,
    Array<(n: { method: string; params?: Record<string, unknown> }) => void>
  >();
  private nextId = 0;
  /** How many times each method was registered — must be exactly once. */
  readonly registrations: string[] = [];

  constructor(
    private readonly caps: ServerCapabilities | undefined,
    private readonly era: "legacy" | "modern",
    /** When false, the port has no `listen` at all (legacy client shape). */
    supportsListen = true,
  ) {
    if (!supportsListen) {
      (this as { listen?: unknown }).listen = undefined;
    }
  }

  getServerCapabilities(): ServerCapabilities | undefined {
    return this.caps;
  }
  getProtocolEra(): "legacy" | "modern" {
    return this.era;
  }
  setNotificationHandler(
    method: string,
    handler: (n: { method: string; params?: Record<string, unknown> }) => void,
  ): void {
    this.registrations.push(method);
    const existing = this.handlers.get(method) ?? [];
    existing.push(handler);
    this.handlers.set(method, existing);
  }
  async subscribeResource(params: { uri: string }): Promise<unknown> {
    this.subscribeCalls.push(params.uri);
    if (this.failSubscribeFor.has(params.uri)) {
      throw new Error(`server refused ${params.uri}`);
    }
    return {};
  }
  async unsubscribeResource(params: { uri: string }): Promise<unknown> {
    this.unsubscribeCalls.push(params.uri);
    return {};
  }

  listen = async (
    filter: SubscriptionFilterShape,
  ): Promise<McpSubscriptionHandle> => {
    this.listenAttempts += 1;
    if (this.failListenWith) {
      throw new Error(this.failListenWith);
    }
    const id = `listen:${++this.nextId}`;
    let settle: (r: "local" | "graceful" | "remote") => void = () => {};
    const closed = new Promise<"local" | "graceful" | "remote">((resolve) => {
      settle = resolve;
    });
    let honored: SubscriptionFilterShape = filter;
    const entry: FixtureListen = {
      id,
      filter,
      closedLocally: false,
      acknowledge: (h?: SubscriptionFilterShape) => {
        honored = h ?? filter;
        this.emit(SubscriptionsAcknowledgedNotificationMethod, {
          notifications: honored,
          _meta: { [SUBSCRIPTION_ID_META_KEY]: id },
        });
      },
      endGracefully: () => settle("graceful"),
      dropRemotely: () => settle("remote"),
    };
    this.listens.push(entry);
    const handle: McpSubscriptionHandle = {
      get honoredFilter() {
        return honored;
      },
      subscriptionId: id,
      close: async () => {
        entry.closedLocally = true;
        settle("local");
      },
      closed,
    };
    return handle;
  };

  /** Push a notification to every registered handler for `method`. */
  emit(method: string, params?: Record<string, unknown>): void {
    for (const handler of this.handlers.get(method) ?? []) {
      handler({ method, params });
    }
  }

  /** Push a change notification stamped with a subscription id. */
  emitOnStream(
    id: string,
    method: string,
    params: Record<string, unknown> = {},
  ): void {
    this.emit(method, {
      ...params,
      _meta: { [SUBSCRIPTION_ID_META_KEY]: id },
    });
  }
}

interface Harness {
  client: FixtureClient;
  coordinator: SubscriptionCoordinator;
  delivered: DeliveredSubscriptionNotification[];
  rejected: RejectedSubscriptionNotification[];
  stale: DeliveredSubscriptionNotification[];
  sleeps: number[];
}

function makeHarness(
  era: "legacy" | "modern",
  caps: ServerCapabilities | undefined = MODERN_CAPS,
  overrides: Partial<{
    maxAttempts: number;
    supportsListen: boolean;
  }> = {},
): Harness {
  const client = new FixtureClient(caps, era, overrides.supportsListen ?? true);
  const delivered: DeliveredSubscriptionNotification[] = [];
  const rejected: RejectedSubscriptionNotification[] = [];
  const stale: DeliveredSubscriptionNotification[] = [];
  const sleeps: number[] = [];
  let clock = 1_000;
  const coordinator = new SubscriptionCoordinator({
    client,
    era,
    now: () => ++clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    reconnect: {
      maxAttempts: overrides.maxAttempts ?? 2,
      initialDelayMs: 10,
      factor: 2,
      maxDelayMs: 100,
    },
    onNotification: (e) => delivered.push(e),
    onRejectedNotification: (e) => rejected.push(e),
    onStale: (e) => stale.push(e),
  });
  return { client, coordinator, delivered, rejected, stale, sleeps };
}

/** Lets queued coordinator work (re-listen chains) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("resolveRequestedFilter", () => {
  it("omits unadvertised selections from the request but reports them", () => {
    const { requested, rejected } = resolveRequestedFilter(
      {
        toolsListChanged: true,
        promptsListChanged: true,
        resourceUris: ["file:///a"],
      },
      { tools: { listChanged: true } } as ServerCapabilities,
    );
    expect(requested).toEqual({ toolsListChanged: true });
    expect(rejected).toEqual([
      {
        interest: "prompts-list-changed",
        reason: "capability-not-advertised",
      },
      {
        interest: "resource-updated",
        uri: "file:///a",
        reason: "capability-not-advertised",
      },
    ]);
  });
});

describe("SubscriptionCoordinator — modern (subscriptions/listen)", () => {
  it("stays opening until the acknowledgement, then goes active", async () => {
    const { client, coordinator, delivered, rejected } = makeHarness("modern");
    let resolveAck: (() => void) | undefined;
    // Open with a client whose ack is deferred: patch listen to withhold the
    // handle's honoredFilter until the fixture acknowledges.
    const original = client.listen;
    client.listen = async (filter) => {
      const handle = await original(filter);
      await new Promise<void>((r) => {
        resolveAck = r;
      });
      return handle;
    };

    const pending = coordinator.setDesiredInterests({ toolsListChanged: true });
    await flush();
    // Not acknowledged yet: no stream is active and notifications are refused.
    expect(coordinator.getActiveStream()).toBeUndefined();
    client.emitOnStream("listen:1", ToolListChangedNotificationMethod);
    expect(delivered).toHaveLength(0);
    expect(rejected.at(-1)?.reason).toBe("stream-not-active");

    client.listens[0].acknowledge();
    resolveAck?.();
    await pending;

    const active = coordinator.getActiveStream();
    expect(active?.status).toBe("active");
    expect(active?.mcpSubscriptionId).toBe("listen:1");
    expect(active?.acknowledgedAt).toBeGreaterThan(active!.openedAt);
  });

  it("tracks requested and acknowledged filters separately", async () => {
    const { client, coordinator } = makeHarness("modern");
    const original = client.listen;
    client.listen = async (filter) => {
      const handle = await original(filter);
      // Server honors only part of the request.
      client.listens.at(-1)!.acknowledge({ toolsListChanged: true });
      return {
        ...handle,
        honoredFilter: { toolsListChanged: true },
      } as McpSubscriptionHandle;
    };

    await coordinator.setDesiredInterests({
      toolsListChanged: true,
      promptsListChanged: true,
      resourceUris: ["file:///a"],
    });

    const stream = coordinator.getActiveStream()!;
    expect(stream.requestedFilter).toEqual({
      toolsListChanged: true,
      promptsListChanged: true,
      resourceSubscriptions: ["file:///a"],
    });
    expect(stream.acknowledgedFilter).toEqual({ toolsListChanged: true });
    expect(stream.rejectedInterests).toEqual([
      { interest: "prompts-list-changed", reason: "not-acknowledged-by-server" },
      {
        interest: "resource-updated",
        uri: "file:///a",
        reason: "not-acknowledged-by-server",
      },
    ]);
  });

  it("rejects a notification type that was not acknowledged", async () => {
    const { client, coordinator, delivered, rejected } = makeHarness("modern");
    const original = client.listen;
    client.listen = async (filter) => {
      const handle = await original(filter);
      client.listens.at(-1)!.acknowledge({ toolsListChanged: true });
      return {
        ...handle,
        honoredFilter: { toolsListChanged: true },
      } as McpSubscriptionHandle;
    };
    await coordinator.setDesiredInterests({ toolsListChanged: true });

    client.emitOnStream("listen:1", "notifications/prompts/list_changed");
    expect(delivered).toHaveLength(0);
    expect(rejected.at(-1)).toMatchObject({
      method: "notifications/prompts/list_changed",
      subscriptionId: "listen:1",
      reason: "unrequested-type",
    });

    client.emitOnStream("listen:1", ToolListChangedNotificationMethod);
    expect(delivered.map((d) => d.kind)).toEqual(["tools-list-changed"]);
  });

  // The rejection history grows on input the PEER controls, and nothing used to
  // evict from it: a server that keeps pushing an unacknowledged type adds a
  // record per notification for the life of the connection.
  it("caps the retained rejection history without hiding rejections from the consumer", async () => {
    const { client, coordinator, rejected } = makeHarness("modern");
    const original = client.listen;
    client.listen = async (filter) => {
      const handle = await original(filter);
      client.listens.at(-1)!.acknowledge({ toolsListChanged: true });
      return {
        ...handle,
        honoredFilter: { toolsListChanged: true },
      } as McpSubscriptionHandle;
    };
    await coordinator.setDesiredInterests({ toolsListChanged: true });

    for (let i = 0; i < 250; i++) {
      client.emitOnStream("listen:1", "notifications/prompts/list_changed");
    }

    // Every rejection still reaches `onRejectedNotification`. The cap is on what
    // the coordinator RETAINS, not on what it reports.
    expect(rejected).toHaveLength(250);

    const retained = coordinator.getRejectedNotifications();
    expect(retained).toHaveLength(200);
    // Oldest evicted: what survives is the tail, which is what describes
    // whatever is wrong right now.
    expect(retained).toEqual(rejected.slice(-200));
  });

  it("keeps request-scoped progress/log notifications out of the store", async () => {
    const { client, coordinator, delivered, rejected } = makeHarness("modern");
    await coordinator.setDesiredInterests({ toolsListChanged: true });
    // The coordinator never registers these methods; simulate a stray dispatch.
    client.emit("notifications/progress", {
      _meta: { [SUBSCRIPTION_ID_META_KEY]: "listen:1" },
    });
    expect(delivered).toHaveLength(0);
    expect(
      client.registrations.filter((m) => m === "notifications/progress"),
    ).toHaveLength(0);
    expect(rejected).toHaveLength(0);
  });

  it("registers each handler exactly once and demuxes concurrent streams by id", async () => {
    const { client, coordinator, delivered } = makeHarness("modern");
    await coordinator.setDesiredInterests({ toolsListChanged: true });
    // A second, independent coordinator over the SAME client stands in for a
    // second concurrent subscription (multiple concurrent listens are legal).
    const second = new SubscriptionCoordinator({
      client,
      era: "modern",
      onNotification: (e) => delivered.push(e),
    });
    await second.setDesiredInterests({ promptsListChanged: true });

    const first = coordinator.getActiveStream()!;
    const other = second.getActiveStream()!;
    expect(first.mcpSubscriptionId).toBe("listen:1");
    expect(other.mcpSubscriptionId).toBe("listen:2");
    expect(
      client.registrations.filter((m) => m === ToolListChangedNotificationMethod),
    ).toHaveLength(2); // once per coordinator, never once per stream

    client.emitOnStream("listen:1", ToolListChangedNotificationMethod);
    client.emitOnStream("listen:2", "notifications/prompts/list_changed");

    expect(
      delivered.map((d) => [d.subscriptionId, d.localSubscriptionId, d.kind]),
    ).toEqual([
      ["listen:1", first.localId, "tools-list-changed"],
      ["listen:2", other.localId, "prompts-list-changed"],
    ]);
    await second.dispose();
  });

  it("delivers the notification before marking lists stale", async () => {
    const { client, coordinator, delivered, stale } = makeHarness("modern");
    await coordinator.setDesiredInterests({ toolsListChanged: true });
    client.emitOnStream("listen:1", ToolListChangedNotificationMethod);
    expect(delivered).toHaveLength(1);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toBe(delivered[0]);
  });

  it("distinguishes graceful close from remote loss and re-listens only after loss", async () => {
    const graceful = makeHarness("modern");
    await graceful.coordinator.setDesiredInterests({ toolsListChanged: true });
    graceful.client.listens[0].endGracefully();
    await flush();
    let streams = graceful.coordinator.getStreams();
    expect(streams).toHaveLength(1);
    expect(streams[0]).toMatchObject({
      status: "graceful-closed",
      closeReason: "graceful",
    });
    expect(graceful.client.listens).toHaveLength(1); // no re-listen

    const lost = makeHarness("modern");
    await lost.coordinator.setDesiredInterests({ toolsListChanged: true });
    lost.client.listens[0].dropRemotely();
    await flush();
    streams = lost.coordinator.getStreams();
    expect(streams[0]).toMatchObject({
      status: "remote-closed",
      closeReason: "remote",
    });
    expect(lost.client.listens).toHaveLength(2); // re-listened, not resumed
    expect(streams[1]).toMatchObject({ status: "active", reconnectAttempt: 1 });
    expect(lost.sleeps).toEqual([10]);
  });

  it("keeps spending the re-listen budget when the re-open itself fails", async () => {
    const lost = makeHarness("modern", MODERN_CAPS, { maxAttempts: 2 });
    await lost.coordinator.setDesiredInterests({ toolsListChanged: true });
    // The server is gone, not just the stream: every re-open throws.
    lost.client.failListenWith = "fetch failed";
    lost.client.listens.at(-1)!.dropRemotely();
    for (let i = 0; i < 5; i++) await flush();

    // Initial open + the full budget of re-opens, all of them waited out.
    expect(lost.client.listenAttempts).toBe(3);
    expect(lost.sleeps).toEqual([10, 20]);
    // A failed re-open is the same remote loss, NOT a new `error` outcome.
    expect(lost.coordinator.getStreams().at(-1)).toMatchObject({
      status: "remote-closed",
      closeReason: "remote",
      error: "fetch failed",
      reconnectAttempt: 2,
    });
  });

  it("bounds re-listen attempts with exponential backoff", async () => {
    const lost = makeHarness("modern", MODERN_CAPS, { maxAttempts: 2 });
    await lost.coordinator.setDesiredInterests({ toolsListChanged: true });
    for (let i = 0; i < 4; i++) {
      lost.client.listens.at(-1)!.dropRemotely();
      await flush();
    }
    // initial open + 2 bounded re-listens
    expect(lost.client.listens).toHaveLength(3);
    expect(lost.sleeps).toEqual([10, 20]);
  });

  it("treats a local close as cancelled and does not re-listen", async () => {
    const { client, coordinator } = makeHarness("modern");
    await coordinator.setDesiredInterests({ toolsListChanged: true });
    await coordinator.cancel();
    await flush();
    expect(client.listens[0].closedLocally).toBe(true);
    expect(coordinator.getStreams()[0]).toMatchObject({
      status: "cancelled",
      closeReason: "local-abort",
    });
    expect(client.listens).toHaveLength(1);
  });

  it("closes and reopens when the desired filter changes, but not when it is unchanged", async () => {
    const { client, coordinator } = makeHarness("modern");
    await coordinator.setDesiredInterests({ toolsListChanged: true });
    await coordinator.setDesiredInterests({ toolsListChanged: true });
    expect(client.listens).toHaveLength(1);

    await coordinator.setDesiredInterests({
      toolsListChanged: true,
      resourceUris: ["file:///a"],
    });
    await flush();
    expect(client.listens).toHaveLength(2);
    expect(client.listens[1].filter).toEqual({
      toolsListChanged: true,
      resourceSubscriptions: ["file:///a"],
    });
    expect(coordinator.getStreams()[0]).toMatchObject({ status: "cancelled" });
    // Resource URIs ride the listen filter — never `resources/subscribe`.
    expect(client.subscribeCalls).toEqual([]);
  });

  it("records an error stream when the client cannot listen", async () => {
    const { coordinator } = makeHarness("modern", MODERN_CAPS, {
      supportsListen: false,
    });
    await coordinator.setDesiredInterests({ toolsListChanged: true });
    expect(coordinator.getStreams()[0]).toMatchObject({
      status: "error",
      closeReason: "error",
    });
  });
});

describe("SubscriptionCoordinator — legacy adapter", () => {
  it("drives resources/subscribe per URI and delivers list-changed notifications", async () => {
    const { client, coordinator, delivered } = makeHarness("legacy");
    await coordinator.setDesiredInterests({
      toolsListChanged: true,
      resourceUris: ["file:///a", "file:///b"],
    });
    expect(client.listens).toHaveLength(0);
    expect(client.subscribeCalls).toEqual(["file:///a", "file:///b"]);

    const stream = coordinator.getActiveStream()!;
    expect(stream.era).toBe("legacy");
    expect(stream.mcpSubscriptionId).toBeUndefined();

    // Legacy notifications carry no subscription id.
    client.emit(ToolListChangedNotificationMethod, {});
    client.emit("notifications/resources/updated", { uri: "file:///a" });
    expect(delivered.map((d) => d.kind)).toEqual([
      "tools-list-changed",
      "resource-updated",
    ]);

    // Dropping a URI unsubscribes exactly that URI.
    await coordinator.setDesiredInterests({
      toolsListChanged: true,
      resourceUris: ["file:///a"],
    });
    expect(client.unsubscribeCalls).toEqual(["file:///b"]);

    // Clearing interests tears the synthetic stream down.
    await coordinator.cancel();
    expect(client.unsubscribeCalls).toEqual(["file:///b", "file:///a"]);
    expect(coordinator.getStreams().at(-1)).toMatchObject({
      status: "cancelled",
      closeReason: "local-abort",
    });
  });

  it("shows a refused resources/subscribe as a rejected interest", async () => {
    const { client, coordinator } = makeHarness("legacy");
    client.failSubscribeFor.add("file:///b");
    await coordinator.setDesiredInterests({
      resourceUris: ["file:///a", "file:///b"],
    });
    const stream = coordinator.getActiveStream()!;
    expect(stream.acknowledgedFilter?.resourceSubscriptions).toEqual([
      "file:///a",
    ]);
    expect(stream.rejectedInterests).toEqual([
      {
        interest: "resource-updated",
        uri: "file:///b",
        reason: "not-acknowledged-by-server",
      },
    ]);
  });

  it("omits and reports selections the legacy server does not advertise", async () => {
    const { client, coordinator } = makeHarness("legacy", {
      resources: { listChanged: true },
    } as ServerCapabilities);
    await coordinator.setDesiredInterests({
      resourcesListChanged: true,
      resourceUris: ["file:///a"],
    });
    expect(client.subscribeCalls).toEqual([]);
    expect(coordinator.getActiveStream()?.rejectedInterests).toEqual([
      {
        interest: "resource-updated",
        uri: "file:///a",
        reason: "capability-not-advertised",
      },
    ]);
  });
});
