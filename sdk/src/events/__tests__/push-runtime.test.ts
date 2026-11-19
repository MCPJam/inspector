/**
 * `EventsPushRuntime` against a scripted `events/stream` connection and a
 * scripted inbox: the persisted cursor never moves past an event the inbox
 * did not journal, whatever the append failure and however frames are queued.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventsPushRuntime, type PushConnectionPort } from "../push.js";
import { EVENTS_SUBSCRIPTION_ID_META_KEY } from "../../mcp-client-manager/events-ext-schemas.js";
import {
  EventsActiveNotificationMethod,
  EventsEventNotificationMethod,
} from "../../mcp-client-manager/events-ext.js";
import {
  InboxBackpressureError,
  type InboxAppendEntry,
  type InboxPort,
  type SubscriptionRecord,
} from "../types.js";
import { DRAFT_PROFILE_ID } from "../profiles.js";

type Frame = { method: string; params?: Record<string, unknown> };

/** Each `openStream` is one request; frames are sent on a request by id. */
function scriptedPort() {
  const handlers = new Map<string, (notification: Frame) => void>();
  const opens: Array<{
    id: number;
    cursor: string | null;
    signal: AbortSignal;
  }> = [];
  let nextId = 1;
  const port: PushConnectionPort = {
    openStream(params, options) {
      const id = nextId++;
      opens.push({ id, cursor: params.cursor, signal: options.signal });
      options.onRequestId(id);
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          {
            once: true,
          }
        );
      });
    },
    onNotification(method, handler) {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    },
  };
  const send = (
    requestId: number,
    method: string,
    params: Record<string, unknown>
  ) =>
    handlers.get(method)!({
      method,
      params: {
        ...params,
        _meta: { [EVENTS_SUBSCRIPTION_ID_META_KEY]: requestId },
      },
    });
  return { port, opens, send };
}

/** Journals every append unless a queued failure is thrown instead. */
function scriptedInbox() {
  const journal: InboxAppendEntry[] = [];
  const failures: Error[] = [];
  const inbox = {
    async append(args: { entries: InboxAppendEntry[] }) {
      const failure = failures.shift();
      if (failure) throw failure;
      journal.push(...args.entries);
      return { accepted: args.entries.length, duplicates: 0 };
    },
  } as unknown as InboxPort;
  const journalled = () =>
    journal.map((entry) =>
      "eventId" in entry
        ? entry.eventId
        : `${entry.type}:${"cursor" in entry ? entry.cursor : ""}`
    );
  return { inbox, failures, journalled };
}

function record(lastCursor: string | null): SubscriptionRecord {
  return {
    id: "esub_1",
    projectId: "proj_1",
    environmentId: null,
    bindingKey: "binding_1",
    serverId: "events-push",
    profile: DRAFT_PROFILE_ID,
    eventName: "comment.created",
    arguments: { document_id: "doc_1" },
    mode: "push",
    desiredState: "active",
    observedState: "pending",
    generation: 1,
    nextActionAt: 0,
    consecutiveFailures: 0,
    lastCursor,
  };
}

function event(n: number): Record<string, unknown> {
  return {
    eventId: `evt_${n}`,
    name: "comment.created",
    timestamp: "2026-01-01T00:00:00.000Z",
    data: { comment_id: String(n) },
    cursor: `c${n}`,
  };
}

/** Let the per-stream frame queue drain (appends are microtask-deep). */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function setup(lastCursor: string | null) {
  const connection = scriptedPort();
  const inbox = scriptedInbox();
  const runtime = new EventsPushRuntime({
    port: connection.port,
    inbox: inbox.inbox,
    maxBackoffMs: 100,
  });
  const cursors: Array<string | null> = [];
  const reasons: string[] = [];
  runtime.start(record(lastCursor), {
    onCursor: (cursor) => cursors.push(cursor),
    onOpen: ({ reason }) => reasons.push(reason),
  });
  opened.push(runtime);
  return { ...connection, ...inbox, runtime, cursors, reasons };
}

const opened: EventsPushRuntime[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const runtime of opened.splice(0)) runtime.close();
  vi.useRealTimers();
});

describe("EventsPushRuntime cursor safety on append failure", () => {
  it("reconnects from the committed cursor on a non-backpressure append failure", async () => {
    const t = setup("c0");
    t.send(1, EventsActiveNotificationMethod, { cursor: "c0" });
    await settle();

    // An HttpInboxClient 5xx / timeout / network error — not backpressure.
    t.failures.push(new Error("inbox append failed: HTTP 503"));
    t.send(1, EventsEventNotificationMethod, event(1));
    await settle();
    // Arrives after evt_1 was lost: must not advance past it.
    t.send(1, EventsEventNotificationMethod, event(2));
    await settle();

    expect(t.cursors).toEqual(["c0"]);
    expect(t.journalled()).toEqual([]);
    expect(t.opens[0]!.signal.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(100);
    expect(t.opens).toHaveLength(2);
    expect(t.opens[1]!.cursor).toBe("c0");
    expect(t.reasons).toEqual(["start", "inbox_error"]);

    // The reopened request replays from c0; nothing is lost.
    t.send(2, EventsActiveNotificationMethod, { cursor: "c0" });
    t.send(2, EventsEventNotificationMethod, event(1));
    t.send(2, EventsEventNotificationMethod, event(2));
    await settle();
    expect(t.journalled()).toEqual(["evt_1", "evt_2"]);
    expect(t.cursors.at(-1)).toBe("c2");
  });

  it("ignores a frame already queued behind a failed append once the request is torn down", async () => {
    const t = setup("c0");
    t.send(1, EventsActiveNotificationMethod, { cursor: "c0" });
    await settle();

    t.failures.push(new InboxBackpressureError(2_000));
    // Both frames are queued before evt_1's append settles.
    t.send(1, EventsEventNotificationMethod, event(1));
    t.send(1, EventsEventNotificationMethod, event(2));
    await settle();

    expect(t.journalled()).toEqual([]);
    expect(t.cursors).toEqual(["c0"]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.opens).toHaveLength(2);
    expect(t.opens[1]!.cursor).toBe("c0");
    expect(t.reasons).toEqual(["start", "inbox_backpressure"]);
  });

  for (const [label, failure] of [
    ["backpressure", () => new InboxBackpressureError(2_000)],
    ["a 5xx", () => new Error("inbox append failed: HTTP 503")],
  ] as const) {
    it(`does not advance past a truncated active whose gap marker failed to append (${label})`, async () => {
      const t = setup("c5");
      t.failures.push(failure());
      t.send(1, EventsActiveNotificationMethod, {
        cursor: "c9",
        truncated: true,
      });
      await settle();

      expect(t.cursors).toEqual([]);
      expect(t.journalled()).toEqual([]);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(t.opens).toHaveLength(2);
      // Reopened from the old cursor, so the server reports the gap again.
      expect(t.opens[1]!.cursor).toBe("c5");

      t.send(2, EventsActiveNotificationMethod, {
        cursor: "c9",
        truncated: true,
      });
      await settle();
      expect(t.journalled()).toEqual(["gap:c9"]);
      expect(t.cursors).toEqual(["c9"]);
    });
  }
});
