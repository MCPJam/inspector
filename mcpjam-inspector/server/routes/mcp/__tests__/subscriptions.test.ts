import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { SubscriptionFilterShape } from "@mcpjam/sdk";
import subscriptions, {
  resetSubscriptionRegistry,
} from "../subscriptions.js";
import type {
  SubscriptionBridgeEvent,
  SubscriptionServerStateView,
} from "../../../../shared/subscription-bridge.js";

/**
 * The LOCAL subscription bridge: the browser observes the coordinator the
 * manager owns and states desire; it never issues subscription RPCs itself.
 *
 * The coordinator's own state machine is covered by the SDK's tests — what is
 * asserted here is the bridge contract: era-correct dispatch (modern
 * `subscriptions/listen` close+reopen on a filter change vs legacy per-URI
 * `resources/subscribe`), and that every lifecycle fact the debugger needs
 * (requested vs acknowledged, ids, close reason, refusals) reaches the wire.
 */

type FakeHandle = {
  honoredFilter: SubscriptionFilterShape;
  close: () => Promise<void>;
  closed: Promise<"local" | "graceful" | "remote">;
  subscriptionId?: string;
};

function modernClient(options?: {
  honor?: (filter: SubscriptionFilterShape) => SubscriptionFilterShape;
  /** Advertise the SEP-2663 tasks extension capability. */
  tasksExtension?: boolean;
}) {
  const handlers = new Map<string, (n: any) => void>();
  const opened: SubscriptionFilterShape[] = [];
  const handles: Array<{
    handle: FakeHandle;
    settle: (r: "local" | "graceful" | "remote") => void;
  }> = [];
  let seq = 0;

  const client = {
    getServerCapabilities: () => ({
      tools: { listChanged: true },
      prompts: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
      ...(options?.tasksExtension
        ? { extensions: { "io.modelcontextprotocol/tasks": {} } }
        : {}),
    }),
    getProtocolEra: () => "modern" as const,
    setNotificationHandler: (method: string, handler: (n: any) => void) => {
      handlers.set(method, handler);
    },
    subscribeResource: vi.fn(async () => ({})),
    unsubscribeResource: vi.fn(async () => ({})),
    listen: vi.fn(async (filter: SubscriptionFilterShape) => open(filter)),
  };
  // Shared handle machinery: the ordinary listen and the manager's
  // declared-listen opener produce structurally identical handles.
  function open(filter: SubscriptionFilterShape): FakeHandle {
    opened.push(filter);
    let settle!: (r: "local" | "graceful" | "remote") => void;
    const closed = new Promise<"local" | "graceful" | "remote">((resolve) => {
      settle = resolve;
    });
    const handle: FakeHandle = {
      honoredFilter: options?.honor ? options.honor(filter) : filter,
      close: async () => settle("local"),
      closed,
      subscriptionId: `sub-${++seq}`,
    };
    handles.push({ handle, settle });
    return handle;
  }
  return { client, opened, handles, handlers, open };
}

function legacyClient() {
  const client = {
    getServerCapabilities: () => ({
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
    }),
    getProtocolEra: () => "legacy" as const,
    setNotificationHandler: () => {},
    subscribeResource: vi.fn(async () => ({})),
    unsubscribeResource: vi.fn(async () => ({})),
  };
  return { client };
}

function appFor(
  client: unknown,
  options?: {
    /** The manager's probe; the route installs the opener only when true. */
    supportsTaskDeclaredListen?: boolean;
    listenWithTasksDeclaration?: (
      filter: SubscriptionFilterShape,
    ) => Promise<FakeHandle>;
  },
) {
  const manager = {
    getManagedClient: () => client,
    supportsTaskDeclaredListen: vi.fn(
      () => options?.supportsTaskDeclaredListen ?? false,
    ),
    listenWithTasksDeclaration: vi.fn(
      async (_serverId: string, filter: SubscriptionFilterShape) => {
        if (!options?.listenWithTasksDeclaration) {
          throw new Error("declared listen not wired in this test");
        }
        return options.listenWithTasksDeclaration(filter);
      },
    ),
  } as any;
  resetSubscriptionRegistry(manager);
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = manager;
    await next();
  });
  app.route("/api/mcp/subscriptions", subscriptions);
  return { app, manager };
}

async function postDesired(
  app: Hono,
  desired: Record<string, unknown>,
): Promise<SubscriptionServerStateView> {
  const res = await app.request("/api/mcp/subscriptions/desired", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverId: "srv", desired }),
  });
  const body = (await res.json()) as {
    success: boolean;
    state: SubscriptionServerStateView;
  };
  expect(res.status).toBe(200);
  expect(body.success).toBe(true);
  return body.state;
}

/** Reads SSE frames until `count` JSON events have arrived, then aborts. */
async function readEvents(
  app: Hono,
  count: number,
  drive: () => Promise<void>,
): Promise<SubscriptionBridgeEvent[]> {
  const controller = new AbortController();
  const res = await app.request("/api/mcp/subscriptions/stream", {
    method: "GET",
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SubscriptionBridgeEvent[] = [];
  const pump = (async () => {
    let buffer = "";
    while (events.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split("\n\n")) {
        if (!line.startsWith("data: ")) continue;
        events.push(JSON.parse(line.slice("data: ".length)));
      }
      buffer = "";
    }
  })();
  await drive();
  await pump;
  controller.abort();
  await reader.cancel().catch(() => {});
  return events;
}

describe("POST /api/mcp/subscriptions/desired (modern era)", () => {
  it("opens a listen stream and reports requested vs acknowledged separately", async () => {
    // The server honors only tools; the prompts selection must show up as a
    // rejection rather than quietly missing from the acknowledged filter.
    const { client, opened } = modernClient({
      honor: () => ({ toolsListChanged: true }),
    });
    const { app } = appFor(client);

    const state = await postDesired(app, {
      toolsListChanged: true,
      promptsListChanged: true,
    });

    expect(client.listen).toHaveBeenCalledTimes(1);
    expect(opened[0]).toEqual({
      toolsListChanged: true,
      promptsListChanged: true,
    });
    expect(state.era).toBe("modern");
    expect(state.supportsListen).toBe(true);
    expect(state.streams).toHaveLength(1);
    const [stream] = state.streams;
    expect(stream.status).toBe("active");
    expect(stream.mcpSubscriptionId).toBe("sub-1");
    expect(stream.idBinding).toBe("reported");
    expect(stream.requestedFilter).toEqual({
      toolsListChanged: true,
      promptsListChanged: true,
    });
    expect(stream.acknowledgedFilter).toEqual({ toolsListChanged: true });
    expect(stream.rejectedInterests).toContainEqual({
      interest: "prompts-list-changed",
      reason: "not-acknowledged-by-server",
    });
  });

  it("a changed desired filter closes the stream and reopens a new one", async () => {
    const { client, opened } = modernClient();
    const { app } = appFor(client);

    await postDesired(app, { toolsListChanged: true });
    const state = await postDesired(app, {
      toolsListChanged: true,
      resourcesListChanged: true,
    });

    expect(client.listen).toHaveBeenCalledTimes(2);
    expect(opened[1]).toEqual({
      toolsListChanged: true,
      resourcesListChanged: true,
    });
    expect(state.streams).toHaveLength(2);
    expect(state.streams[0].status).toBe("cancelled");
    expect(state.streams[0].closeReason).toBe("local-abort");
    expect(state.streams[1].status).toBe("active");
    expect(state.streams[1].mcpSubscriptionId).toBe("sub-2");
    // No `resources/subscribe` on the modern path — the filter IS the verb.
    expect(client.subscribeResource).not.toHaveBeenCalled();
  });

  it("an unchanged desired filter leaves the live stream alone", async () => {
    const { client } = modernClient();
    const { app } = appFor(client);

    await postDesired(app, { toolsListChanged: true });
    const state = await postDesired(app, { toolsListChanged: true });

    expect(client.listen).toHaveBeenCalledTimes(1);
    expect(state.streams).toHaveLength(1);
    expect(state.streams[0].status).toBe("active");
  });

  it("distinguishes a graceful close from a remote loss on the wire", async () => {
    const { client, handles } = modernClient();
    const { app } = appFor(client);
    await postDesired(app, { toolsListChanged: true });

    const graceful = await readEvents(app, 2, async () => {
      handles[0].settle("graceful");
      await new Promise((r) => setTimeout(r, 10));
    });
    const gracefulEvent = graceful.find(
      (e) => e.type === "subscription_stream",
    );
    expect(gracefulEvent).toBeDefined();
    if (gracefulEvent?.type !== "subscription_stream") throw new Error("bad");
    expect(gracefulEvent.stream.status).toBe("graceful-closed");
    expect(gracefulEvent.stream.closeReason).toBe("graceful");

    // A remote loss on a fresh stream is a different status AND a different
    // close reason — never flattened into one "disconnected".
    const { client: c2, handles: h2 } = modernClient();
    const { app: app2 } = appFor(c2);
    await postDesired(app2, { toolsListChanged: true });
    const remote = await readEvents(app2, 2, async () => {
      h2[0].settle("remote");
      await new Promise((r) => setTimeout(r, 10));
    });
    const remoteEvent = remote.find((e) => e.type === "subscription_stream");
    if (remoteEvent?.type !== "subscription_stream") throw new Error("bad");
    expect(remoteEvent.stream.status).toBe("remote-closed");
    expect(remoteEvent.stream.closeReason).toBe("remote");
  });

  it("broadcasts a refused notification type instead of dropping it", async () => {
    const { client, handlers } = modernClient({
      honor: () => ({ toolsListChanged: true }),
    });
    const { app } = appFor(client);
    await postDesired(app, { toolsListChanged: true });

    const events = await readEvents(app, 2, async () => {
      handlers.get("notifications/prompts/list_changed")?.({
        method: "notifications/prompts/list_changed",
        params: {
          _meta: { "io.modelcontextprotocol/subscriptionId": "sub-1" },
        },
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    const rejected = events.find((e) => e.type === "subscription_rejected");
    if (rejected?.type !== "subscription_rejected") throw new Error("bad");
    expect(rejected.rejection.method).toBe(
      "notifications/prompts/list_changed",
    );
    expect(rejected.rejection.reason).toBe("unrequested-type");
  });

  it("cancel ends the stream as a local abort", async () => {
    const { client } = modernClient();
    const { app } = appFor(client);
    await postDesired(app, { toolsListChanged: true });

    const res = await app.request("/api/mcp/subscriptions/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: "srv" }),
    });
    const body = (await res.json()) as { state: SubscriptionServerStateView };
    expect(res.status).toBe(200);
    expect(body.state.streams[0].status).toBe("cancelled");
    expect(body.state.streams[0].closeReason).toBe("local-abort");
  });
});

describe("POST /api/mcp/subscriptions/desired (legacy era)", () => {
  it("uses the per-URI resources/subscribe RPCs, not a listen stream", async () => {
    const { client } = legacyClient();
    const { app } = appFor(client);

    const state = await postDesired(app, {
      toolsListChanged: true,
      resourceUris: ["file:///a.txt"],
    });

    expect(client.subscribeResource).toHaveBeenCalledWith({
      uri: "file:///a.txt",
    });
    expect(state.era).toBe("legacy");
    expect(state.supportsListen).toBe(false);
    expect(state.streams).toHaveLength(1);
    expect(state.streams[0].era).toBe("legacy");
    expect(state.streams[0].status).toBe("active");
    expect(state.streams[0].acknowledgedFilter?.resourceSubscriptions).toEqual([
      "file:///a.txt",
    ]);
  });

  it("dropping a URI unsubscribes it and keeps the same synthetic stream", async () => {
    const { client } = legacyClient();
    const { app } = appFor(client);

    const first = await postDesired(app, {
      resourceUris: ["file:///a.txt", "file:///b.txt"],
    });
    const second = await postDesired(app, { resourceUris: ["file:///a.txt"] });

    expect(client.unsubscribeResource).toHaveBeenCalledWith({
      uri: "file:///b.txt",
    });
    expect(second.streams).toHaveLength(1);
    expect(second.streams[0].localId).toBe(first.streams[0].localId);
    expect(second.streams[0].acknowledgedFilter?.resourceSubscriptions).toEqual(
      ["file:///a.txt"],
    );
  });
});

describe("subscription bridge validation", () => {
  it("rejects a missing serverId", async () => {
    const { app } = appFor(modernClient().client);
    const res = await app.request("/api/mcp/subscriptions/desired", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ desired: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("404s when the server is not connected", async () => {
    const { app } = appFor(undefined);
    const res = await app.request("/api/mcp/subscriptions/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: "srv" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("task-filtered notifications (extension wire, B2)", () => {
  it("round-trips desired taskIds un-stripped into a DECLARED listen", async () => {
    const { client, opened } = modernClient({ tasksExtension: true });
    const { app, manager } = appFor(client, {
      supportsTaskDeclaredListen: true,
      // The declared opener rides the same handle machinery as plain listen;
      // in production it is the manager's listenWithTasksDeclaration.
      listenWithTasksDeclaration: async (filter) =>
        (await client.listen(filter)) as FakeHandle,
    });

    const state = await postDesired(app, {
      toolsListChanged: true,
      taskIds: ["task-1", "task-2"],
    });

    // The filter reached the wire through the DECLARED opener, verbatim.
    expect(manager.listenWithTasksDeclaration).toHaveBeenCalledTimes(1);
    expect(manager.listenWithTasksDeclaration).toHaveBeenCalledWith("srv", {
      toolsListChanged: true,
      taskIds: ["task-1", "task-2"],
    });
    expect(opened[0].taskIds).toEqual(["task-1", "task-2"]);

    expect(state.supportsTaskDeclaredListen).toBe(true);
    expect(state.desired.taskIds).toEqual(["task-1", "task-2"]);
    expect(state.streams).toHaveLength(1);
    expect(state.streams[0].status).toBe("active");
    expect(state.streams[0].requestedFilter.taskIds).toEqual([
      "task-1",
      "task-2",
    ]);
    expect(state.streams[0].acknowledgedFilter?.taskIds).toEqual([
      "task-1",
      "task-2",
    ]);
  });

  it("omits the declared-listen method when the probe fails: taskIds dropped, not sent", async () => {
    // Extension advertised by the server, but the CONNECTION cannot declare
    // (probe false) — the port must not carry the method at all, so the
    // coordinator records the drop and never sends an undeclared filter.
    const { client } = modernClient({ tasksExtension: true });
    const { app, manager } = appFor(client, {
      supportsTaskDeclaredListen: false,
    });

    const state = await postDesired(app, { taskIds: ["task-1"] });

    expect(manager.listenWithTasksDeclaration).not.toHaveBeenCalled();
    expect(client.listen).not.toHaveBeenCalled();
    expect(state.supportsTaskDeclaredListen).toBe(false);
    // The refusal is a first-class fact: an unopened stream record carrying
    // the tasks-declaration-unavailable rejection, so the UI can explain why
    // notifications never arrive while polling continues.
    expect(state.streams).toHaveLength(1);
    expect(state.streams[0].rejectedInterests).toContainEqual({
      interest: "tasks",
      taskId: "task-1",
      reason: "tasks-declaration-unavailable",
    });
  });

  it("forwards the taskId on a delivered notifications/tasks broadcast", async () => {
    const { client, handlers } = modernClient({ tasksExtension: true });
    const { app } = appFor(client, {
      supportsTaskDeclaredListen: true,
      listenWithTasksDeclaration: async (filter) =>
        (await client.listen(filter)) as FakeHandle,
    });
    await postDesired(app, { taskIds: ["task-1"] });

    const events = await readEvents(app, 2, async () => {
      handlers.get("notifications/tasks")?.({
        method: "notifications/tasks",
        params: {
          taskId: "task-1",
          status: "working",
          createdAt: "2026-07-28T00:00:00Z",
          lastUpdatedAt: "2026-07-28T00:00:01Z",
          _meta: { "io.modelcontextprotocol/subscriptionId": "sub-1" },
        },
      });
      await new Promise((r) => setTimeout(r, 10));
    });

    const delivered = events.find(
      (e) => e.type === "subscription_notification",
    );
    if (delivered?.type !== "subscription_notification") throw new Error("bad");
    expect(delivered.notification.kind).toBe("tasks");
    // The taskId is the poll-now hint's target; the DetailedTask params are
    // NOT forwarded as state — tasks/get stays the source of truth.
    expect(delivered.notification.taskId).toBe("task-1");
  });

  it("normalizeDesired keeps only string task ids and the state view carries the probe", async () => {
    const { client } = modernClient({ tasksExtension: true });
    const { app, manager } = appFor(client, {
      supportsTaskDeclaredListen: true,
      listenWithTasksDeclaration: async (filter) =>
        (await client.listen(filter)) as FakeHandle,
    });

    const state = await postDesired(app, {
      taskIds: ["task-1", 42, null, "task-2"],
    });

    expect(manager.listenWithTasksDeclaration).toHaveBeenCalledWith("srv", {
      taskIds: ["task-1", "task-2"],
    });
    expect(state.desired.taskIds).toEqual(["task-1", "task-2"]);
    expect(state.supportsTaskDeclaredListen).toBe(true);
  });
});
