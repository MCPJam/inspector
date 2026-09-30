/**
 * The events coordinator lifecycle suite — written ONCE, run against every
 * inbox adapter (contract C9: "a fake-clock lifecycle test suite written once
 * and run against every adapter").
 *
 * The MCP side is a scripted fake (`ScriptedEventsServer`) so every rule is
 * exercised deterministically on a fake clock; the real-wire behaviour is
 * covered separately by `events-wire.integration.test.ts`. What varies per
 * adapter is only the {@link InboxPort} — the SDK's `MemoryEventInbox` here,
 * and the inspector's HTTP client for the hosted inbox in its own tests.
 */

import { describe, expect, it } from "vitest";
import {
  EventsCoordinator,
  IDLE_NEXT_ACTION_AT,
  applySubscriptionPatch,
} from "../../src/events/coordinator.js";
import {
  InboxBackpressureError,
  type EventsRpcPort,
  type InboxPort,
  type SubscriptionRecord,
} from "../../src/events/types.js";
import { DRAFT_PROFILE_ID } from "../../src/events/profiles.js";

export interface LifecycleAdapter {
  name: string;
  /** A fresh inbox for one test, on the given clock. */
  makeInbox(clock: { now(): number }): Promise<{
    inbox: InboxPort;
    /** Journal entries for a logical subscription, oldest first. */
    entries(logicalSubscriptionId: string): Promise<
      Array<{ kind: string; eventId?: string; cursor: string | null }>
    >;
    /** Make the next N appends fail with backpressure. */
    applyBackpressure(times: number): void;
    close?(): Promise<void>;
  }>;
}

type PollPage = {
  events: Array<{ eventId: string; name?: string; data?: Record<string, unknown> }>;
  cursor?: string | null;
  hasMore?: boolean;
  truncated?: boolean;
  nextPollMs?: number;
};

/** A scripted MCP server: every call is recorded; answers come from queues. */
export class ScriptedEventsServer implements EventsRpcPort {
  calls: Array<{ method: string; params: any }> = [];
  pollPages: Array<PollPage | Error> = [];
  subscribeAnswers: Array<
    | { id: string; refreshBefore: string | null; cursor?: string | null; truncated?: boolean }
    | Error
  > = [];
  unsubscribeAnswers: Array<"removed" | "already-gone" | Error> = [];

  async list() {
    this.calls.push({ method: "events/list", params: {} });
    return { events: [] };
  }
  async poll(params: any) {
    this.calls.push({ method: "events/poll", params });
    const next: PollPage | Error = this.pollPages.shift() ?? {
      events: [],
      cursor: params.cursor,
    };
    if (next instanceof Error) throw next;
    return {
      events: next.events.map((event) => ({
        eventId: event.eventId,
        name: event.name ?? "thing.happened",
        timestamp: "2026-09-30T00:00:00Z",
        data: event.data ?? {},
      })),
      ...("cursor" in next ? { cursor: next.cursor } : {}),
      ...(next.hasMore !== undefined ? { hasMore: next.hasMore } : {}),
      ...(next.truncated !== undefined ? { truncated: next.truncated } : {}),
      ...(next.nextPollMs !== undefined ? { nextPollMs: next.nextPollMs } : {}),
    } as any;
  }
  async subscribe(params: any) {
    this.calls.push({ method: "events/subscribe", params });
    const next = this.subscribeAnswers.shift() ?? {
      id: "sub_1",
      refreshBefore: null,
    };
    if (next instanceof Error) throw next;
    return next as any;
  }
  async unsubscribe(params: any) {
    this.calls.push({ method: "events/unsubscribe", params });
    const next = this.unsubscribeAnswers.shift() ?? "removed";
    if (next instanceof Error) throw next;
    return next;
  }
  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }
}

export function rpcError(code: number, message = "error", data?: unknown): Error {
  const error = new Error(message) as Error & { code: number; data?: unknown };
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

function baseRecord(overrides: Partial<SubscriptionRecord>): SubscriptionRecord {
  return {
    id: "esub_suite",
    projectId: "proj_1",
    environmentId: null,
    bindingKey: "binding_1",
    serverId: "srv_1",
    profile: DRAFT_PROFILE_ID,
    eventName: "thing.happened",
    arguments: { scope: "a" },
    mode: "poll",
    desiredState: "active",
    observedState: "pending",
    generation: 1,
    nextActionAt: 0,
    consecutiveFailures: 0,
    ...overrides,
  };
}

export function runEventsLifecycleSuite(adapter: LifecycleAdapter): void {
  describe(`events coordinator lifecycle — ${adapter.name}`, () => {
    async function setup(options: { maxPagesPerStep?: number } = {}) {
      const clock = { value: 1_000_000, now() { return this.value; } };
      const harness = await adapter.makeInbox(clock);
      const server = new ScriptedEventsServer();
      const coordinator = new EventsCoordinator({
        clock,
        rpc: async () => server,
        inbox: async () => harness.inbox,
        ...(options.maxPagesPerStep !== undefined
          ? { maxPagesPerStep: options.maxPagesPerStep }
          : {}),
      });
      return { clock, harness, server, coordinator };
    }

    // ---- poll ----------------------------------------------------------

    it("starts from now with a null cursor and advances on an empty batch", async () => {
      const { server, coordinator, harness } = await setup();
      server.pollPages.push({ events: [], cursor: "p1", nextPollMs: 5_000 });
      let sub = baseRecord({});
      const outcome = await coordinator.step(sub);
      expect(server.calls[0]!.params.cursor).toBeNull();
      sub = applySubscriptionPatch(sub, outcome);
      expect(sub.lastCursor).toBe("p1");
      expect(outcome.nextActionAt).toBe(1_000_000 + 5_000);
      expect(await harness.entries(sub.id)).toEqual([]);
      await harness.close?.();
    });

    it("treats an absent cursor as null", async () => {
      const { server, coordinator, harness } = await setup();
      server.pollPages.push({ events: [] });
      const sub = applySubscriptionPatch(
        baseRecord({ lastCursor: "old" }),
        await coordinator.step(baseRecord({ lastCursor: "old" }))
      );
      expect(sub.lastCursor).toBeNull();
      await harness.close?.();
    });

    it("applies the 1000 ms floor to nextPollMs", async () => {
      const { server, coordinator, harness } = await setup();
      server.pollPages.push({ events: [], cursor: "p1", nextPollMs: 5 });
      const outcome = await coordinator.step(baseRecord({}));
      expect(outcome.nextActionAt).toBe(1_000_000 + 1_000);
      await harness.close?.();
    });

    it("drains hasMore with bounded fairness", async () => {
      const { server, coordinator, harness } = await setup({ maxPagesPerStep: 2 });
      server.pollPages.push(
        { events: [{ eventId: "e1" }], cursor: "p1", hasMore: true },
        { events: [{ eventId: "e2" }], cursor: "p2", hasMore: true },
        { events: [{ eventId: "e3" }], cursor: "p3", hasMore: false }
      );
      let sub = baseRecord({});
      const first = await coordinator.step(sub);
      sub = applySubscriptionPatch(sub, first);
      expect(server.count("events/poll")).toBe(2);
      expect(sub.lastCursor).toBe("p2");
      // Due again immediately, behind other due subscriptions.
      expect(first.nextActionAt).toBe(1_000_000);
      const second = await coordinator.step(sub);
      sub = applySubscriptionPatch(sub, second);
      expect(sub.lastCursor).toBe("p3");
      expect((await harness.entries(sub.id)).map((e) => e.eventId)).toEqual([
        "e1",
        "e2",
        "e3",
      ]);
      await harness.close?.();
    });

    it("never advances the cursor past a batch the inbox did not accept", async () => {
      const { server, coordinator, harness } = await setup();
      harness.applyBackpressure(1);
      server.pollPages.push({ events: [{ eventId: "e1" }], cursor: "p1" });
      let sub = baseRecord({ lastCursor: "p0" });
      const paused = await coordinator.step(sub);
      sub = applySubscriptionPatch(sub, paused);
      expect(paused.failure?.kind).toBe("inbox_backpressure");
      expect(sub.lastCursor).toBe("p0");
      expect(paused.nextActionAt).toBeGreaterThan(1_000_000);
      // Retried from the same cursor, the batch lands exactly once.
      server.pollPages.push({ events: [{ eventId: "e1" }], cursor: "p1" });
      sub = applySubscriptionPatch(sub, await coordinator.step(sub));
      expect(sub.lastCursor).toBe("p1");
      expect((await harness.entries(sub.id)).map((e) => e.eventId)).toEqual(["e1"]);
      await harness.close?.();
    });

    it("dedupes a batch re-polled after a crash before the cursor commit", async () => {
      const { server, coordinator, harness } = await setup();
      const sub = baseRecord({ lastCursor: "p0" });
      server.pollPages.push({ events: [{ eventId: "e1" }], cursor: "p1" });
      await coordinator.step(sub); // committed to the inbox, patch "lost"
      server.pollPages.push({ events: [{ eventId: "e1" }, { eventId: "e2" }], cursor: "p2" });
      await coordinator.step(sub); // same cursor re-polled
      expect((await harness.entries(sub.id)).map((e) => e.eventId)).toEqual(["e1", "e2"]);
      await harness.close?.();
    });

    it("records truncated as an explicit gap without resubscribing", async () => {
      const { server, coordinator, harness } = await setup();
      server.pollPages.push({ events: [], cursor: "fresh", truncated: true });
      const sub = applySubscriptionPatch(
        baseRecord({ lastCursor: "stale" }),
        await coordinator.step(baseRecord({ lastCursor: "stale" }))
      );
      expect(sub.lastGapAt).toBe(1_000_000);
      expect(sub.lastCursor).toBe("fresh");
      expect(await harness.entries(sub.id)).toEqual([
        expect.objectContaining({ kind: "gap", cursor: "fresh" }),
      ]);
      expect(server.count("events/subscribe")).toBe(0);
      await harness.close?.();
    });

    // ---- failure classification -----------------------------------------

    it("pauses on lost authorization and never retries by itself", async () => {
      const { server, coordinator, harness } = await setup();
      const unauthorized = new Error("Unauthorized");
      unauthorized.name = "UnauthorizedError";
      server.pollPages.push(unauthorized);
      let sub = applySubscriptionPatch(baseRecord({}), await coordinator.step(baseRecord({})));
      expect(sub.observedState).toBe("paused_auth");
      expect(sub.nextActionAt).toBe(IDLE_NEXT_ACTION_AT);
      const again = await coordinator.step(sub);
      expect(again.action).toBe("idle");
      expect(server.count("events/poll")).toBe(1);
      // Forbidden from the events profile is the same condition.
      server.pollPages.push(rpcError(-32012, "Forbidden"));
      sub = applySubscriptionPatch(baseRecord({}), await coordinator.step(baseRecord({})));
      expect(sub.observedState).toBe("paused_auth");
      await harness.close?.();
    });

    it("stops on terminal errors and backs off on transient ones", async () => {
      const { server, coordinator, harness } = await setup();
      server.pollPages.push(rpcError(-32011, "NotFound", { kind: "event" }));
      let sub = applySubscriptionPatch(baseRecord({}), await coordinator.step(baseRecord({})));
      expect(sub.observedState).toBe("error");
      expect(sub.lastError?.retryable).toBe(false);
      expect((await coordinator.step(sub)).action).toBe("idle");

      server.pollPages.push(new Error("socket hang up"), new Error("socket hang up"));
      sub = baseRecord({});
      const first = await coordinator.step(sub);
      sub = applySubscriptionPatch(sub, first);
      const second = await coordinator.step(sub);
      expect(second.nextActionAt - 1_000_000).toBeGreaterThan(
        first.nextActionAt - 1_000_000
      );
      expect(applySubscriptionPatch(sub, second).consecutiveFailures).toBe(2);
      await harness.close?.();
    });

    it("pins -32011..-32015 to events methods only", async () => {
      const { classifyEventsRpcError } = await import(
        "../../src/mcp-client-manager/events-ext-guards.js"
      );
      expect(classifyEventsRpcError("events/poll", rpcError(-32013))?.kind).toBe(
        "ResourceExhausted"
      );
      expect(classifyEventsRpcError("tools/call", rpcError(-32013))).toBeUndefined();
      expect(classifyEventsRpcError("events/poll", rpcError(-32000))).toBeUndefined();
    });

    // ---- webhook ---------------------------------------------------------

    it("health-checks a no-expiry grant instead of never looking again", async () => {
      const { server, coordinator, harness } = await setup();
      server.subscribeAnswers.push({ id: "sub_1", refreshBefore: null, cursor: "w1" });
      const sub = applySubscriptionPatch(
        baseRecord({ mode: "webhook" }),
        await coordinator.step(baseRecord({ mode: "webhook" }))
      );
      expect(sub.refreshBefore).toBeNull();
      expect(sub.nextActionAt).toBe(1_000_000 + 6 * 60 * 60 * 1000);
      await harness.close?.();
    });

    it("sends the profile's ttlMs, or an explicit null for no expiry", async () => {
      const { server, coordinator, harness } = await setup();
      await coordinator.step(baseRecord({ mode: "webhook" }));
      expect(server.calls.at(-1)!.params.ttlMs).toBe(3_600_000);
      await coordinator.step(baseRecord({ mode: "webhook", ttlMs: null }));
      expect(server.calls.at(-1)!.params).toHaveProperty("ttlMs", null);
      await harness.close?.();
    });

    it("refreshes before refreshBefore with the persisted cursor", async () => {
      const { clock, server, coordinator, harness } = await setup();
      const grant = new Date(1_000_000 + 10 * 60 * 1000).toISOString();
      server.subscribeAnswers.push({ id: "sub_1", refreshBefore: grant, cursor: "w1" });
      let sub = applySubscriptionPatch(
        baseRecord({ mode: "webhook" }),
        await coordinator.step(baseRecord({ mode: "webhook" }))
      );
      // 10% of 10 min = 60 s lead.
      expect(sub.nextActionAt).toBe(1_000_000 + 9 * 60 * 1000);
      clock.value = sub.nextActionAt;
      server.subscribeAnswers.push({ id: "sub_1", refreshBefore: grant, cursor: "w2" });
      const refreshed = await coordinator.step(sub);
      expect(refreshed.action).toBe("refreshed");
      expect(server.calls.at(-1)!.params.cursor).toBe("w1");
      expect(server.calls.at(-1)!.params.delivery.url).toBe(sub.callbackUrl);
      sub = applySubscriptionPatch(sub, refreshed);
      expect(sub.lastCursor).toBe("w2");
      await harness.close?.();
    });

    it("gives up on challenge_failed after a bounded number of attempts", async () => {
      const { server, coordinator, harness } = await setup();
      let sub = baseRecord({ mode: "webhook" });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        server.subscribeAnswers.push(
          rpcError(-32015, "CallbackEndpointError", { reason: "challenge_failed" })
        );
        sub = applySubscriptionPatch(sub, await coordinator.step(sub));
      }
      expect(sub.observedState).toBe("error");
      expect(sub.lastError).toMatchObject({
        kind: "callback_challenge_failed",
        retryable: false,
      });
      await harness.close?.();
    });

    it("counts only consecutive challenge failures toward that bound", async () => {
      const { server, coordinator, harness } = await setup();
      const challengeFailed = () =>
        rpcError(-32015, "CallbackEndpointError", {
          reason: "challenge_failed",
        });
      let sub = baseRecord({ mode: "webhook" });
      // An outage on the first subscribe …
      for (let attempt = 0; attempt < 4; attempt += 1) {
        server.subscribeAnswers.push(new Error("socket hang up"));
        sub = applySubscriptionPatch(sub, await coordinator.step(sub));
      }
      expect(sub.consecutiveFailures).toBe(4);
      // … does not spend the challenge attempts: this is the first of five.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        server.subscribeAnswers.push(challengeFailed());
        sub = applySubscriptionPatch(sub, await coordinator.step(sub));
      }
      expect(sub.observedState).toBe("pending");
      expect(sub.lastError).toMatchObject({
        kind: "callback_challenge_failed",
        retryable: true,
      });
      expect(sub.consecutiveFailures).toBe(4);
      server.subscribeAnswers.push(challengeFailed());
      sub = applySubscriptionPatch(sub, await coordinator.step(sub));
      expect(sub.observedState).toBe("error");
      expect(sub.lastError?.retryable).toBe(false);
      await harness.close?.();
    });

    it("allocates a fresh slot when a first subscribe outlives the pending one", async () => {
      const { clock, server, coordinator, harness } = await setup();
      let sub = baseRecord({ mode: "webhook" });
      server.subscribeAnswers.push(new Error("socket hang up"));
      sub = applySubscriptionPatch(sub, await coordinator.step(sub));
      const first = { slotId: sub.slotId!, callbackUrl: sub.callbackUrl! };
      // The backoff (5 s, 10 s, 20 s, …) carries the retries past the slot's
      // 15 min pending TTL; until then the live slot is reused.
      const expiresAt = 1_000_000 + 15 * 60 * 1000;
      while (sub.nextActionAt < expiresAt) {
        clock.value = sub.nextActionAt;
        server.subscribeAnswers.push(new Error("socket hang up"));
        sub = applySubscriptionPatch(sub, await coordinator.step(sub));
        expect(sub.slotId).toBe(first.slotId);
      }
      expect(sub.consecutiveFailures).toBe(8);
      // The expired slot's URL answers 410, so a challenge sent there could
      // only fail: the subscribe that finally lands uses a new slot.
      clock.value = sub.nextActionAt;
      sub = applySubscriptionPatch(sub, await coordinator.step(sub));
      expect(sub.observedState).toBe("active");
      expect(sub.slotId).not.toBe(first.slotId);
      expect(sub.callbackUrl).not.toBe(first.callbackUrl);
      expect(server.calls.at(-1)!.params.delivery.url).toBe(sub.callbackUrl);
      expect(sub.serverSubscriptionId).toBe("sub_1");
      await harness.close?.();
    });

    it("pauses and resumes at the same callback URL", async () => {
      const { server, coordinator, harness } = await setup();
      let sub = applySubscriptionPatch(
        baseRecord({ mode: "webhook" }),
        await coordinator.step(baseRecord({ mode: "webhook" }))
      );
      const url = sub.callbackUrl;
      sub = { ...sub, desiredState: "paused", generation: 2 };
      sub = applySubscriptionPatch(sub, await coordinator.step(sub));
      expect(sub.observedState).toBe("paused");
      expect(server.count("events/unsubscribe")).toBe(1);
      sub = { ...sub, desiredState: "active", generation: 3 };
      sub = applySubscriptionPatch(sub, await coordinator.step(sub));
      expect(sub.observedState).toBe("active");
      expect(server.calls.at(-1)!.params.delivery.url).toBe(url);
      await harness.close?.();
    });

    it("binds the new server id when resume gets one", async () => {
      const { server, coordinator, harness } = await setup();
      let sub = applySubscriptionPatch(
        baseRecord({ mode: "webhook" }),
        await coordinator.step(baseRecord({ mode: "webhook" }))
      );
      expect(sub.serverSubscriptionId).toBe("sub_1");
      sub = { ...sub, desiredState: "paused", generation: 2 };
      sub = applySubscriptionPatch(sub, await coordinator.step(sub));
      // The draft does not require a server to reuse an id it unsubscribed.
      server.subscribeAnswers.push({ id: "sub_2", refreshBefore: null });
      sub = { ...sub, desiredState: "active", generation: 3 };
      sub = applySubscriptionPatch(sub, await coordinator.step(sub));
      expect(sub.observedState).toBe("active");
      expect(sub.serverSubscriptionId).toBe("sub_2");
      expect(sub.conflictingServerSubscriptionId).toBeUndefined();
      expect(sub.lastError).toBeUndefined();
      // So the next pause still unsubscribes it.
      sub = { ...sub, desiredState: "paused", generation: 4 };
      sub = applySubscriptionPatch(sub, await coordinator.step(sub));
      expect(sub.observedState).toBe("paused");
      expect(server.count("events/unsubscribe")).toBe(2);
      await harness.close?.();
    });

    it("removal unsubscribes twice across the late-refresh window", async () => {
      const { clock, server, coordinator, harness } = await setup();
      let sub = applySubscriptionPatch(
        baseRecord({ mode: "webhook" }),
        await coordinator.step(baseRecord({ mode: "webhook" }))
      );
      sub = { ...sub, desiredState: "removed", generation: 2 };
      sub = applySubscriptionPatch(sub, await coordinator.step(sub));
      expect(sub.observedState).toBe("removing");
      expect(sub.nextActionAt).toBe(clock.value + 2 * 60 * 1000);
      clock.value = sub.nextActionAt;
      server.unsubscribeAnswers.push("already-gone");
      sub = applySubscriptionPatch(sub, await coordinator.step(sub));
      expect(sub.observedState).toBe("removed");
      expect(server.count("events/unsubscribe")).toBe(2);
      expect((await coordinator.step(sub)).action).toBe("idle");
      await harness.close?.();
    });

    it("removing a poll subscription needs no server call", async () => {
      const { server, coordinator, harness } = await setup();
      const sub = applySubscriptionPatch(
        baseRecord({ desiredState: "removed" }),
        await coordinator.step(baseRecord({ desiredState: "removed" }))
      );
      expect(sub.observedState).toBe("removed");
      expect(server.calls).toEqual([]);
      await harness.close?.();
    });
  });
}

/** An InboxPort wrapper that injects backpressure N times. */
export function withInjectedBackpressure(inbox: InboxPort): {
  inbox: InboxPort;
  applyBackpressure(times: number): void;
} {
  let remaining = 0;
  return {
    applyBackpressure(times: number) {
      remaining = times;
    },
    inbox: new Proxy(inbox, {
      get(target, property, receiver) {
        if (property === "append") {
          return async (...args: Parameters<InboxPort["append"]>) => {
            if (remaining > 0) {
              remaining -= 1;
              throw new InboxBackpressureError(5_000);
            }
            return target.append(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  };
}
