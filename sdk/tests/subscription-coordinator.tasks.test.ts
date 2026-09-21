/**
 * Task notifications over `subscriptions/listen`
 * (`io.modelcontextprotocol/tasks`, SEP-2663).
 *
 * Two rules drive every case here:
 *
 *  1. Task notifications are OPTIONAL in the extension. They may reduce
 *     polling; they may never be required for correctness. So every path that
 *     cannot establish the stream must degrade to polling *visibly* — the
 *     handle is never lost and the reason is always recorded.
 *  2. A task-filtered listen MUST carry the per-request eligibility
 *     declaration, or the server answers `-32021` (`tasks.md:797-799`). A
 *     connection that cannot declare must therefore not send one at all.
 */

import { describe, expect, it } from "vitest";
import type { ServerCapabilities } from "@modelcontextprotocol/client";
import {
  SubscriptionCoordinator,
  SUBSCRIPTION_ID_META_KEY,
  SubscriptionsAcknowledgedNotificationMethod,
  TasksNotificationMethod,
  resolveRequestedFilter,
  type DeliveredSubscriptionNotification,
  type McpSubscriptionHandle,
  type RejectedSubscriptionNotification,
  type SubscriptionClientPort,
  type SubscriptionFilterShape,
  type SubscriptionStreamRecord,
} from "../src/mcp-client-manager/subscription-coordinator.js";

const TASKS_EXT = "io.modelcontextprotocol/tasks";

const EXTENSION_CAPS = {
  tools: { listChanged: true },
  extensions: { [TASKS_EXT]: {} },
} as unknown as ServerCapabilities;

/** A 2026-07-28 server that does NOT advertise the tasks extension. */
const NO_TASKS_CAPS = {
  tools: { listChanged: true },
} as ServerCapabilities;

interface FixtureListen {
  filter: SubscriptionFilterShape;
  declared: boolean;
  /** Re-emit the ack as a notification (the coordinator treats it idempotently). */
  acknowledge: (honored?: SubscriptionFilterShape) => void;
  dropRemotely: () => void;
  closeLocally: () => void;
}

class TaskFixtureClient implements SubscriptionClientPort {
  readonly listens: FixtureListen[] = [];
  private handlers = new Map<
    string,
    Array<(n: { method: string; params?: Record<string, unknown> }) => void>
  >();
  private nextId = 0;

  constructor(
    private readonly caps: ServerCapabilities | undefined,
    /** When false the client cannot declare on a listen (no seam). */
    private readonly canDeclare = true
  ) {
    if (!canDeclare) {
      (
        this as { listenWithTasksDeclaration?: unknown }
      ).listenWithTasksDeclaration = undefined;
    }
  }

  getServerCapabilities(): ServerCapabilities | undefined {
    return this.caps;
  }
  getProtocolEra(): "legacy" | "modern" {
    return "modern";
  }
  setNotificationHandler(
    method: string,
    handler: (n: { method: string; params?: Record<string, unknown> }) => void
  ): void {
    const existing = this.handlers.get(method) ?? [];
    existing.push(handler);
    this.handlers.set(method, existing);
  }
  async subscribeResource(): Promise<unknown> {
    return {};
  }
  async unsubscribeResource(): Promise<unknown> {
    return {};
  }

  listen = (filter: SubscriptionFilterShape) => this.open(filter, false);

  listenWithTasksDeclaration = (filter: SubscriptionFilterShape) =>
    this.open(filter, true);

  /**
   * What the NEXT open resolves its `honoredFilter` with. Mirrors upstream,
   * where `listen()` resolves on the acknowledgement and `honoredFilter` IS
   * the acknowledged filter — so a server honoring only a subset is expressed
   * here, before the open, not by a later notification.
   */
  nextHonoredFilter?: SubscriptionFilterShape;

  private async open(
    filter: SubscriptionFilterShape,
    declared: boolean
  ): Promise<McpSubscriptionHandle> {
    const id = `listen:${++this.nextId}`;
    let settle: (r: "local" | "graceful" | "remote") => void = () => {};
    const closed = new Promise<"local" | "graceful" | "remote">((resolve) => {
      settle = resolve;
    });
    let honored: SubscriptionFilterShape = this.nextHonoredFilter ?? filter;
    this.nextHonoredFilter = undefined;
    this.listens.push({
      filter,
      declared,
      closeLocally: () => settle("local"),
      acknowledge: (h?: SubscriptionFilterShape) => {
        honored = h ?? filter;
        this.emit(SubscriptionsAcknowledgedNotificationMethod, {
          notifications: honored,
          _meta: { [SUBSCRIPTION_ID_META_KEY]: id },
        });
      },
      dropRemotely: () => settle("remote"),
    });
    return {
      get honoredFilter() {
        return honored;
      },
      subscriptionId: id,
      close: async () => settle("local"),
      closed,
    };
  }

  emit(method: string, params?: Record<string, unknown>): void {
    for (const handler of this.handlers.get(method) ?? []) {
      handler({ method, params });
    }
  }

  /** Deliver a full `DetailedTask` on the stream, as SEP-2663 specifies. */
  emitTask(listenIndex: number, task: Record<string, unknown>): void {
    this.emit(TasksNotificationMethod, {
      ...task,
      _meta: { [SUBSCRIPTION_ID_META_KEY]: `listen:${listenIndex + 1}` },
    });
  }
}

function harness(
  caps: ServerCapabilities | undefined = EXTENSION_CAPS,
  canDeclare = true
) {
  const client = new TaskFixtureClient(caps, canDeclare);
  const delivered: DeliveredSubscriptionNotification[] = [];
  const rejected: RejectedSubscriptionNotification[] = [];
  const streams: SubscriptionStreamRecord[] = [];
  let clock = 1_000;
  const coordinator = new SubscriptionCoordinator({
    client,
    era: "modern",
    now: () => ++clock,
    sleep: async () => {},
    reconnect: { maxAttempts: 1, initialDelayMs: 1, factor: 2, maxDelayMs: 10 },
    onNotification: (e) => delivered.push(e),
    onRejectedNotification: (e) => rejected.push(e),
    onStreamChange: (s) => streams.push(s),
  });
  return { client, coordinator, delivered, rejected, streams };
}

const workingTask = (taskId: string) => ({
  taskId,
  status: "working",
  createdAt: "2026-07-28T00:00:00Z",
  lastUpdatedAt: "2026-07-28T00:00:01Z",
  ttlMs: null,
});

describe("filter resolution", () => {
  it("requests taskIds when the server advertises the tasks extension", () => {
    const { requested, rejected } = resolveRequestedFilter(
      { taskIds: ["t1", "t2"] },
      EXTENSION_CAPS,
      "modern"
    );
    expect(requested.taskIds).toEqual(["t1", "t2"]);
    expect(rejected).toEqual([]);
  });

  it("rejects taskIds when the server does not advertise the extension", () => {
    const { requested, rejected } = resolveRequestedFilter(
      { taskIds: ["t1"] },
      NO_TASKS_CAPS,
      "modern"
    );
    expect(requested.taskIds).toBeUndefined();
    expect(rejected).toEqual([
      { interest: "tasks", taskId: "t1", reason: "capability-not-advertised" },
    ]);
  });

  it("treats the extension as absent when the capability value is not an object", () => {
    for (const bad of [true, "yes", [], null]) {
      const { requested } = resolveRequestedFilter(
        { taskIds: ["t1"] },
        { extensions: { [TASKS_EXT]: bad } } as unknown as ServerCapabilities,
        "modern"
      );
      expect(requested.taskIds).toBeUndefined();
    }
  });

  // The extension capability is a plain capability read with no era in it, so
  // the era rule has to live at the call site. This is the exported entry
  // point — any consumer outside the coordinator gets its filter from here,
  // and a legacy filter carrying an extension-only member is exactly the
  // legacy/extension mixing this plan forbids.
  it("drops taskIds on a legacy connection EVEN IF the server advertises the extension", () => {
    for (const era of ["legacy", undefined] as const) {
      const { requested, rejected } = resolveRequestedFilter(
        { taskIds: ["t1"] },
        EXTENSION_CAPS,
        era
      );
      expect(requested.taskIds).toBeUndefined();
      expect(rejected).toEqual([
        {
          interest: "tasks",
          taskId: "t1",
          reason: "capability-not-advertised",
        },
      ]);
    }
  });

  it("dedupes task ids", () => {
    const { requested } = resolveRequestedFilter(
      { taskIds: ["t1", "t1", "t2"] },
      EXTENSION_CAPS,
      "modern"
    );
    expect(requested.taskIds).toEqual(["t1", "t2"]);
  });
});

describe("opening the stream", () => {
  it("opens through the DECLARED opener when the filter carries task ids", async () => {
    const h = harness();
    await h.coordinator.setDesiredInterests({ taskIds: ["t1"] });

    expect(h.client.listens).toHaveLength(1);
    expect(h.client.listens[0].declared).toBe(true);
    expect(h.client.listens[0].filter.taskIds).toEqual(["t1"]);
  });

  it("uses the plain opener when no task ids are wanted", async () => {
    const h = harness();
    await h.coordinator.setDesiredInterests({ toolsListChanged: true });
    expect(h.client.listens[0].declared).toBe(false);
  });

  it("drops task ids — and says why — when the connection cannot declare", async () => {
    const h = harness(EXTENSION_CAPS, /* canDeclare */ false);
    await h.coordinator.setDesiredInterests({
      toolsListChanged: true,
      taskIds: ["t1"],
    });

    // The listen still goes out for the other interests, WITHOUT taskIds: an
    // undeclared task-filtered listen would be a guaranteed -32021.
    expect(h.client.listens).toHaveLength(1);
    expect(h.client.listens[0].filter.taskIds).toBeUndefined();

    const stream = h.coordinator.getStreams().at(-1)!;
    expect(stream.rejectedInterests).toContainEqual({
      interest: "tasks",
      taskId: "t1",
      reason: "tasks-declaration-unavailable",
    });
  });

  it("records an unacknowledged task id as rejected, so the caller knows to keep polling", async () => {
    const h = harness();
    h.client.nextHonoredFilter = { taskIds: ["t1"] };
    await h.coordinator.setDesiredInterests({ taskIds: ["t1", "t2"] });

    const stream = h.coordinator.getStreams().at(-1)!;
    expect(stream.rejectedInterests).toContainEqual({
      interest: "tasks",
      taskId: "t2",
      reason: "not-acknowledged-by-server",
    });
  });
});

describe("delivery", () => {
  it("delivers a full DetailedTask for an acknowledged task id", async () => {
    const h = harness();
    await h.coordinator.setDesiredInterests({ taskIds: ["t1"] });
    h.client.listens[0].acknowledge();
    h.client.emitTask(0, { ...workingTask("t1"), pollIntervalMs: 2_000 });

    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toMatchObject({
      kind: "tasks",
      method: TasksNotificationMethod,
      taskId: "t1",
    });
    // The whole task rides in the params — this is not a bare "something
    // changed" ping, so a consumer can reconcile without a follow-up read.
    expect(h.delivered[0].params).toMatchObject({
      status: "working",
      pollIntervalMs: 2_000,
    });
  });

  it("refuses a task id the server acknowledged but we never requested", async () => {
    const h = harness();
    // The server echoes back MORE than it was asked for. `diffAcknowledgement`
    // only records what a server DROPPED, so an id it ADDED survives into
    // `acknowledgedFilter` unchallenged — and enforcing against that filter
    // alone let it through. Task ids are bearer-like handles, so this is a
    // server pushing state for another surface's task.
    await h.coordinator.setDesiredInterests({ taskIds: ["t1"] });
    h.client.listens[0].acknowledge({ taskIds: ["t1", "someone-elses"] });

    h.client.emitTask(0, workingTask("someone-elses"));
    expect(h.delivered).toEqual([]);
    expect(h.rejected.at(-1)).toMatchObject({ reason: "unrequested-type" });

    // ...and the id we actually asked for still arrives.
    h.client.emitTask(0, workingTask("t1"));
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]).toMatchObject({ taskId: "t1" });
  });

  it("refuses a task notification for an id we never asked about", async () => {
    const h = harness();
    await h.coordinator.setDesiredInterests({ taskIds: ["t1"] });
    h.client.listens[0].acknowledge();
    h.client.emitTask(0, workingTask("someone-elses-task"));

    expect(h.delivered).toEqual([]);
    expect(h.rejected.at(-1)).toMatchObject({ reason: "unrequested-type" });
  });

  it("refuses a task notification for an id the server did not acknowledge", async () => {
    const h = harness();
    // The server honors only `t1`, so pushing `t2` is unsolicited even though
    // we asked for it — the ACKNOWLEDGED filter is what gates delivery.
    h.client.nextHonoredFilter = { taskIds: ["t1"] };
    await h.coordinator.setDesiredInterests({ taskIds: ["t1", "t2"] });
    h.client.emitTask(0, workingTask("t2"));

    expect(h.delivered).toEqual([]);
    expect(h.rejected.at(-1)).toMatchObject({ reason: "unrequested-type" });

    // ...and `t1` on the same stream still flows.
    h.client.emitTask(0, workingTask("t1"));
    expect(h.delivered).toHaveLength(1);
  });

  it("refuses a task notification carrying no task id at all", async () => {
    const h = harness();
    await h.coordinator.setDesiredInterests({ taskIds: ["t1"] });
    h.client.listens[0].acknowledge();
    h.client.emitTask(0, { status: "working" });

    expect(h.delivered).toEqual([]);
    expect(h.rejected.at(-1)).toMatchObject({ reason: "unrequested-type" });
  });

  it("refuses anything delivered after the stream closed", async () => {
    const h = harness();
    await h.coordinator.setDesiredInterests({ taskIds: ["t1"] });
    await h.coordinator.cancel();
    h.client.emitTask(0, workingTask("t1"));

    expect(h.delivered).toEqual([]);
    expect(h.rejected.at(-1)).toMatchObject({ reason: "stream-not-active" });
  });
});

describe("filter churn", () => {
  it("closes and re-opens when the watched task set changes", async () => {
    const h = harness();
    await h.coordinator.setDesiredInterests({ taskIds: ["t1"] });
    await h.coordinator.setDesiredInterests({ taskIds: ["t1", "t2"] });

    // A listen filter is immutable, so a changed set is a new stream.
    expect(h.client.listens).toHaveLength(2);
    expect(h.client.listens[1].filter.taskIds).toEqual(["t1", "t2"]);
  });

  it("is idempotent when the set is unchanged, even in a different order", async () => {
    const h = harness();
    await h.coordinator.setDesiredInterests({ taskIds: ["t1", "t2"] });
    await h.coordinator.setDesiredInterests({ taskIds: ["t2", "t1"] });
    expect(h.client.listens).toHaveLength(1);
  });

  it("tears the stream down when the last task goes terminal and is dropped", async () => {
    const h = harness();
    await h.coordinator.setDesiredInterests({ taskIds: ["t1"] });
    await h.coordinator.setDesiredInterests({ taskIds: [] });

    const stream = h.coordinator.getStreams().at(-1)!;
    expect(stream.status).toBe("cancelled");
  });

  it("re-listens with the declaration after a remote loss", async () => {
    const h = harness();
    await h.coordinator.setDesiredInterests({ taskIds: ["t1"] });
    h.client.listens[0].acknowledge();
    h.client.listens[0].dropRemotely();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.client.listens).toHaveLength(2);
    // The re-listen must go back out DECLARED, or it earns -32021 on reconnect.
    expect(h.client.listens[1].declared).toBe(true);
    expect(h.client.listens[1].filter.taskIds).toEqual(["t1"]);
  });
});

describe("wire isolation", () => {
  it("never requests task ids on a legacy connection", () => {
    // No era and no extension capability: doubly ineligible.
    const { requested, rejected } = resolveRequestedFilter(
      { taskIds: ["t1"] },
      { tools: { listChanged: true } } as ServerCapabilities
    );
    expect(requested.taskIds).toBeUndefined();
    expect(rejected[0]).toMatchObject({ reason: "capability-not-advertised" });
  });

  it("does not put taskIds on a filter that never asked for them", async () => {
    const h = harness();
    await h.coordinator.setDesiredInterests({ toolsListChanged: true });
    expect(h.client.listens[0].filter).not.toHaveProperty("taskIds");
  });
});

describe("retained stream history", () => {
  it("is bounded, so a tab revising its watched set cannot grow it forever", async () => {
    // Nothing implements `listenWithTasksDeclaration` here, so EVERY revision
    // is a fully-rejected interest set and records a synthetic never-opened
    // stream. A Tasks tab revising its watched set as handles are created and
    // retire does exactly this, once per tick, for the life of the connection.
    const h = harness(EXTENSION_CAPS, false);
    for (let i = 0; i < 200; i += 1) {
      await h.coordinator.setDesiredInterests({ taskIds: [`t${i}`] });
    }
    const streams = h.coordinator.getStreams();
    expect(streams.length).toBeLessThanOrEqual(50);
    // The newest records — the ones a debugger is actually reading — survive.
    expect(streams.at(-1)!.rejectedInterests[0]).toMatchObject({
      taskId: "t199",
    });
  });

  it("never evicts the live stream, however much history piles up", async () => {
    const h = harness();
    for (let i = 0; i < 200; i += 1) {
      await h.coordinator.setDesiredInterests({ taskIds: [`t${i}`] });
      h.client.listens.at(-1)!.acknowledge();
    }
    const active = h.coordinator.getActiveStream();
    expect(active).toBeDefined();
    expect(active!.requestedFilter.taskIds).toEqual(["t199"]);
    expect(h.coordinator.getStreams().length).toBeLessThanOrEqual(50);
  });
});
