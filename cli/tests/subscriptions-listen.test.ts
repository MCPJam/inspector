import assert from "node:assert/strict";
import test from "node:test";
import {
  SUBSCRIPTION_ID_META_KEY,
  SubscriptionCoordinator,
  type DeliveredSubscriptionNotification,
  type RejectedSubscriptionNotification,
  type SubscriptionFilterShape,
  type SubscriptionReconnectPolicy,
  type SubscriptionStreamRecord,
} from "@mcpjam/sdk";
import {
  SubscriptionListenSession,
  hasAnyInterest,
  relistenDelayMs,
  type SubscriptionCoordinatorHandlers,
  type SubscriptionListenEvent,
} from "../src/lib/subscriptions-session.js";
import {
  buildDesiredInterests,
  listenResultError,
  parseRelistenPolicy,
} from "../src/commands/subscriptions.js";

type NotificationLike = {
  method: string;
  params?: Record<string, unknown>;
};

const POLICY: SubscriptionReconnectPolicy = {
  maxAttempts: 0,
  initialDelayMs: 500,
  factor: 2,
  maxDelayMs: 5_000,
};

function stream(
  overrides: Partial<SubscriptionStreamRecord> & { localId: string },
): SubscriptionStreamRecord {
  return {
    era: "modern",
    requestedFilter: { toolsListChanged: true },
    rejectedInterests: [],
    status: "opening",
    openedAt: 1,
    reconnectAttempt: 0,
    ...overrides,
  };
}

interface Harness {
  session: SubscriptionListenSession;
  handlers: SubscriptionCoordinatorHandlers;
  stdout: string[];
  stderr: string[];
  events: () => SubscriptionListenEvent[];
  cancelCalls: number;
  disposeCalls: number;
  fireTimers: () => void;
}

function makeHarness(
  options: {
    reconnect?: SubscriptionReconnectPolicy;
    maxNotifications?: number;
    durationMs?: number;
    onSetDesired?: (harness: Harness) => void | Promise<void>;
    setDesiredRejects?: Error;
  } = {},
): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const timers: Array<() => void> = [];
  let handlers!: SubscriptionCoordinatorHandlers;

  const harness = {
    stdout,
    stderr,
    cancelCalls: 0,
    disposeCalls: 0,
    events: () =>
      stdout.map((line) => JSON.parse(line) as SubscriptionListenEvent),
    fireTimers: () => {
      for (const timer of timers.splice(0)) timer();
    },
  } as Harness;

  harness.session = new SubscriptionListenSession(
    {
      desired: { toolsListChanged: true },
      reconnect: options.reconnect ?? POLICY,
      ...(options.maxNotifications !== undefined
        ? { maxNotifications: options.maxNotifications }
        : {}),
      ...(options.durationMs !== undefined
        ? { durationMs: options.durationMs }
        : {}),
    },
    {
      createCoordinator: (coordinatorHandlers) => {
        handlers = coordinatorHandlers;
        return {
          setDesiredInterests: async () => {
            if (options.setDesiredRejects) throw options.setDesiredRejects;
            await options.onSetDesired?.(harness);
          },
          cancel: async () => {
            harness.cancelCalls += 1;
          },
          dispose: async () => {
            harness.disposeCalls += 1;
          },
        };
      },
      emit: (event) => stdout.push(`${JSON.stringify(event)}\n`.trimEnd()),
      status: (message) => stderr.push(message),
      now: () => 42,
      setTimer: (fn, _ms) => {
        timers.push(fn);
        return { cancel: () => undefined };
      },
    },
  );
  harness.handlers = handlers;
  return harness;
}

function openAndAck(harness: Harness, localId = "local-1"): void {
  harness.handlers.onStreamChange(stream({ localId }));
  harness.handlers.onStreamChange(
    stream({
      localId,
      mcpSubscriptionId: "sub-7",
      status: "active",
      acknowledgedFilter: { toolsListChanged: true },
      acknowledgedAt: 2,
    }),
  );
}

test("open → ack printed distinctly → notifications tagged with subscription ids", async () => {
  const harness = makeHarness({
    onSetDesired: (h) => {
      openAndAck(h);
      const notification: DeliveredSubscriptionNotification = {
        method: "notifications/tools/list_changed",
        kind: "tools-list-changed",
        subscriptionId: "sub-7",
        localSubscriptionId: "local-1",
        at: 3,
      };
      h.handlers.onNotification(notification);
      h.handlers.onStreamChange(
        stream({
          localId: "local-1",
          mcpSubscriptionId: "sub-7",
          status: "graceful-closed",
          closeReason: "graceful",
          acknowledgedFilter: { toolsListChanged: true },
          closedAt: 4,
        }),
      );
    },
  });

  const result = await harness.session.run();
  const events = harness.events();

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "subscription.opened",
      "subscription.acknowledged",
      "notification",
      "subscription.closed",
      "summary",
    ],
  );
  const ack = events[1];
  assert.equal(ack.type, "subscription.acknowledged");
  assert.notEqual(ack.type, "notification");
  assert.deepEqual(
    ack.type === "subscription.acknowledged" ? ack.acknowledgedFilter : null,
    { toolsListChanged: true },
  );
  const delivered = events[2];
  assert.equal(delivered.type, "notification");
  if (delivered.type === "notification") {
    assert.equal(delivered.subscriptionId, "sub-7");
    assert.equal(delivered.localSubscriptionId, "local-1");
  }
  assert.equal(result.outcome, "graceful");
  assert.equal(result.exitCode, 0);
  assert.equal(harness.disposeCalls, 1);
});

test("rejected notifications are reported without ending the stream", async () => {
  const harness = makeHarness({
    onSetDesired: (h) => {
      openAndAck(h);
      const rejected: RejectedSubscriptionNotification = {
        method: "notifications/prompts/list_changed",
        subscriptionId: "sub-7",
        localSubscriptionId: "local-1",
        reason: "unrequested-type",
        at: 3,
      };
      h.handlers.onRejectedNotification(rejected);
      void h.session.stop("signal");
    },
  });

  const result = await harness.session.run();
  const types = harness.events().map((event) => event.type);
  assert.ok(types.includes("notification.rejected"));
  assert.equal(result.rejectedNotifications, 1);
  assert.equal(result.outcome, "cancelled");
});

test("signal exit cancels the subscription and exits cleanly", async () => {
  const harness = makeHarness({
    onSetDesired: async (h) => {
      openAndAck(h);
      await h.session.stop("signal");
    },
  });

  const result = await harness.session.run();
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.stopReason, "signal");
  assert.equal(result.exitCode, 0);
  assert.equal(harness.cancelCalls, 1);
  assert.equal(listenResultError(result), undefined);
});

test("a local abort observed on the stream record still reports cancelled", async () => {
  const harness = makeHarness({
    onSetDesired: (h) => {
      openAndAck(h);
      void h.session.stop("signal");
      h.handlers.onStreamChange(
        stream({
          localId: "local-1",
          status: "cancelled",
          closeReason: "local-abort",
          acknowledgedFilter: { toolsListChanged: true },
          closedAt: 5,
        }),
      );
    },
  });

  const result = await harness.session.run();
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.exitCode, 0);
});

test("graceful and remote closes are distinct outcomes with distinct exit codes", async () => {
  const graceful = makeHarness({
    onSetDesired: (h) => {
      openAndAck(h);
      h.handlers.onStreamChange(
        stream({
          localId: "local-1",
          status: "graceful-closed",
          closeReason: "graceful",
          acknowledgedFilter: { toolsListChanged: true },
          closedAt: 9,
        }),
      );
    },
  });
  const gracefulResult = await graceful.session.run();

  const remote = makeHarness({
    onSetDesired: (h) => {
      openAndAck(h);
      h.handlers.onStreamChange(
        stream({
          localId: "local-1",
          status: "remote-closed",
          closeReason: "remote",
          acknowledgedFilter: { toolsListChanged: true },
          closedAt: 9,
        }),
      );
    },
  });
  const remoteResult = await remote.session.run();

  assert.equal(gracefulResult.outcome, "graceful");
  assert.equal(gracefulResult.exitCode, 0);
  assert.equal(remoteResult.outcome, "remote");
  assert.equal(remoteResult.exitCode, 1);
  assert.notEqual(gracefulResult.exitCode, remoteResult.exitCode);

  const closedEvent = (harness: Harness) =>
    harness
      .events()
      .find((event) => event.type === "subscription.closed") as Extract<
      SubscriptionListenEvent,
      { type: "subscription.closed" }
    >;
  assert.equal(closedEvent(graceful).closeReason, "graceful");
  assert.equal(closedEvent(remote).closeReason, "remote");
  assert.equal(listenResultError(remoteResult)?.code, "SUBSCRIPTION_REMOTE_CLOSED");
});

test("an open failure reports the error outcome", async () => {
  const harness = makeHarness({
    onSetDesired: (h) => {
      h.handlers.onStreamChange(
        stream({
          localId: "local-1",
          status: "error",
          closeReason: "error",
          error: "listen not supported",
          closedAt: 3,
        }),
      );
    },
  });

  const result = await harness.session.run();
  assert.equal(result.outcome, "error");
  assert.equal(result.exitCode, 1);
  assert.equal(listenResultError(result)?.code, "SUBSCRIPTION_FAILED");
});

test("bounded re-listen reports backoff, then gives up with the remote outcome", async () => {
  const reconnect: SubscriptionReconnectPolicy = {
    maxAttempts: 2,
    initialDelayMs: 100,
    factor: 2,
    maxDelayMs: 5_000,
  };
  const harness = makeHarness({
    reconnect,
    onSetDesired: (h) => {
      openAndAck(h);
      // Remote loss #1 → re-listen scheduled (attempt 1).
      h.handlers.onStreamChange(
        stream({
          localId: "local-1",
          status: "remote-closed",
          closeReason: "remote",
          acknowledgedFilter: { toolsListChanged: true },
          closedAt: 5,
        }),
      );
      // Coordinator reopens as a NEW stream carrying the attempt counter.
      h.handlers.onStreamChange(
        stream({ localId: "local-2", reconnectAttempt: 1 }),
      );
      // Remote loss #2 → re-listen scheduled (attempt 2, doubled delay).
      h.handlers.onStreamChange(
        stream({
          localId: "local-2",
          reconnectAttempt: 1,
          status: "remote-closed",
          closeReason: "remote",
          closedAt: 6,
        }),
      );
      h.handlers.onStreamChange(
        stream({ localId: "local-3", reconnectAttempt: 2 }),
      );
      // Remote loss #3 → attempt 3 exceeds the budget; give up.
      h.handlers.onStreamChange(
        stream({
          localId: "local-3",
          reconnectAttempt: 2,
          status: "remote-closed",
          closeReason: "remote",
          closedAt: 7,
        }),
      );
    },
  });

  const result = await harness.session.run();
  const relisten = harness
    .events()
    .filter((event) => event.type === "subscription.relisten");
  assert.deepEqual(
    relisten.map((event) =>
      event.type === "subscription.relisten"
        ? [event.attempt, event.delayMs]
        : null,
    ),
    [
      [1, 100],
      [2, 200],
    ],
  );
  assert.equal(result.outcome, "remote");
  assert.equal(result.exitCode, 1);
  assert.equal(result.relistenAttempts, 2);
});

test("relisten backoff is exponential and capped", () => {
  const policy: SubscriptionReconnectPolicy = {
    maxAttempts: 5,
    initialDelayMs: 100,
    factor: 3,
    maxDelayMs: 500,
  };
  assert.deepEqual(
    [1, 2, 3, 4].map((attempt) => relistenDelayMs(policy, attempt)),
    [100, 300, 500, 500],
  );
});

test("the notification cap stops the stream cleanly", async () => {
  const harness = makeHarness({
    maxNotifications: 2,
    onSetDesired: (h) => {
      openAndAck(h);
      for (let index = 0; index < 3; index += 1) {
        h.handlers.onNotification({
          method: "notifications/tools/list_changed",
          kind: "tools-list-changed",
          subscriptionId: "sub-7",
          localSubscriptionId: "local-1",
          at: 3 + index,
        });
      }
    },
  });

  const result = await harness.session.run();
  assert.equal(result.notifications, 2);
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.stopReason, "max-notifications");
  assert.equal(result.exitCode, 0);
});

test("the duration cap stops the stream cleanly", async () => {
  const harness = makeHarness({
    durationMs: 1_000,
    onSetDesired: (h) => {
      openAndAck(h);
      h.fireTimers();
    },
  });

  const result = await harness.session.run();
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.stopReason, "duration");
  assert.equal(result.exitCode, 0);
});

test("stdout carries only structured JSON; human status goes to stderr", async () => {
  const harness = makeHarness({
    onSetDesired: (h) => {
      openAndAck(h);
      h.handlers.onNotification({
        method: "notifications/resources/updated",
        kind: "resource-updated",
        uri: "file:///a.txt",
        subscriptionId: "sub-7",
        localSubscriptionId: "local-1",
        at: 3,
      });
      h.handlers.onStreamChange(
        stream({
          localId: "local-1",
          status: "graceful-closed",
          closeReason: "graceful",
          acknowledgedFilter: { toolsListChanged: true },
          closedAt: 4,
        }),
      );
    },
  });

  await harness.session.run();

  for (const line of harness.stdout) {
    assert.doesNotThrow(() => JSON.parse(line));
    assert.equal(line.includes("\n"), false, "each event must be one line");
  }
  assert.ok(harness.stderr.length > 0, "human status must exist on stderr");
  assert.ok(
    harness.stderr.some((line) => line.startsWith("Acknowledged:")),
    "the ack must be reported to humans too",
  );
  assert.equal(
    harness.stdout.some((line) => line.startsWith("Acknowledged:")),
    false,
  );
  const summary = harness.events().at(-1);
  assert.equal(summary?.type, "summary");
});

test("a coordinator that cannot open reports error rather than hanging", async () => {
  const harness = makeHarness({
    setDesiredRejects: new Error("transport closed"),
  });
  const result = await harness.session.run();
  assert.equal(result.outcome, "error");
  assert.equal(result.error, "transport closed");
});

test("drives the real coordinator: ack gates delivery and stamps ids", async () => {
  // Fixture client speaking the modern era: `listen` resolves on the ack, and
  // notifications are stamped with the listen request's id.
  const handlers = new Map<string, (n: NotificationLike) => void>();
  let closeStream: (reason: "local" | "graceful" | "remote") => void = () =>
    undefined;
  const client = {
    getServerCapabilities: () => ({
      tools: { listChanged: true },
      resources: { listChanged: true, subscribe: true },
    }),
    getProtocolEra: () => "modern" as const,
    setNotificationHandler: (
      method: string,
      handler: (n: NotificationLike) => void,
    ) => {
      handlers.set(method, handler);
    },
    subscribeResource: async () => ({}),
    unsubscribeResource: async () => ({}),
    listen: async (filter: SubscriptionFilterShape) => ({
      honoredFilter: filter,
      subscriptionId: "sub-42",
      close: async () => closeStream("local"),
      closed: new Promise<"local" | "graceful" | "remote">((resolve) => {
        closeStream = resolve;
      }),
    }),
  };

  const stdout: string[] = [];
  const session = new SubscriptionListenSession(
    {
      desired: { toolsListChanged: true, resourceUris: ["file:///a.txt"] },
      reconnect: POLICY,
    },
    {
      createCoordinator: (coordinatorHandlers) =>
        new SubscriptionCoordinator({
          client,
          reconnect: POLICY,
          ...coordinatorHandlers,
        }),
      emit: (event) => stdout.push(JSON.stringify(event)),
      status: () => undefined,
    },
  );

  const run = session.run();
  // Let the listen round-trip settle before the server emits.
  await new Promise((resolve) => setImmediate(resolve));
  handlers.get("notifications/resources/updated")?.({
    method: "notifications/resources/updated",
    params: {
      uri: "file:///a.txt",
      _meta: { [SUBSCRIPTION_ID_META_KEY]: "sub-42" },
    },
  });
  closeStream("graceful");
  const result = await run;

  const events = stdout.map(
    (line) => JSON.parse(line) as SubscriptionListenEvent,
  );
  const ack = events.find(
    (event) => event.type === "subscription.acknowledged",
  );
  assert.ok(ack, "the acknowledgement is its own event");
  assert.deepEqual(
    ack?.type === "subscription.acknowledged" ? ack.acknowledgedFilter : null,
    { toolsListChanged: true, resourceSubscriptions: ["file:///a.txt"] },
  );
  const notification = events.find((event) => event.type === "notification");
  assert.equal(
    notification?.type === "notification" ? notification.subscriptionId : null,
    "sub-42",
  );
  assert.equal(result.outcome, "graceful");
  assert.equal(result.notifications, 1);
});

test("interest flags map to era-neutral desired interests", () => {
  assert.deepEqual(buildDesiredInterests({ listChanged: true }), {
    toolsListChanged: true,
    promptsListChanged: true,
    resourcesListChanged: true,
    resourceUris: [],
  });
  assert.deepEqual(
    buildDesiredInterests({
      resourceUri: ["file:///a.txt", "file:///a.txt", "file:///b.txt"],
    }).resourceUris,
    ["file:///a.txt", "file:///b.txt"],
  );
  assert.equal(hasAnyInterest(buildDesiredInterests({})), false);
  assert.equal(
    hasAnyInterest(buildDesiredInterests({ toolsListChanged: true })),
    true,
  );
});

test("re-listen is off by default and its tuning flags require it", () => {
  assert.equal(parseRelistenPolicy({}).maxAttempts, 0);
  assert.throws(() => parseRelistenPolicy({ relistenDelayMs: 10 }), /--relisten/);
  const policy = parseRelistenPolicy({
    relisten: 3,
    relistenDelayMs: 50,
    relistenMaxDelayMs: 20,
  });
  assert.equal(policy.maxAttempts, 3);
  assert.equal(policy.initialDelayMs, 50);
  // A max below the initial delay would make the backoff shrink; clamp up.
  assert.equal(policy.maxDelayMs, 50);
});
