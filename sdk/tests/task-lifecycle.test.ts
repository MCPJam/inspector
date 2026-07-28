/**
 * The shared task lifecycle engine (`src/mcp-client-manager/task-lifecycle.ts`).
 *
 * The load-bearing property here is the poll-interval rule. Before the engine,
 * the Tasks tab collapsed every active task to `Math.min(...)` of their
 * advertised intervals and resolved a user override with `??` — so one fast
 * task set the floor for all of them, and a user preference *replaced* the
 * server's floor instead of being clamped by it. These tests pin the opposite:
 * every term is a `max`, and a batch takes the slowest member's floor.
 */

import { describe, expect, it } from "vitest";
import {
  TaskLifecycleEngine,
  isTerminalLifecycleStatus,
  taskLifecycleKey,
  type TaskLifecycleIdentity,
  type TaskLifecycleSnapshot,
} from "../src/mcp-client-manager/task-lifecycle.js";
import {
  extensionTaskToObservation,
  legacyTaskToObservation,
  isUnknownTaskError,
  parseRetryAfterMs,
} from "../src/mcp-client-manager/task-lifecycle-adapters.js";

const identity = (taskId: string, overrides: Partial<TaskLifecycleIdentity> = {}): TaskLifecycleIdentity => ({
  serverId: "srv",
  wire: "extension",
  taskId,
  ...overrides,
});

/** A clock the tests advance by hand, so nothing depends on wall time. */
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
      return current;
    },
    set: (ms: number) => {
      current = ms;
      return current;
    },
  };
}

describe("identity", () => {
  it("keeps the wire in the key, so the same id on two wires is two handles", () => {
    const legacy = taskLifecycleKey(identity("t1", { wire: "legacy" }));
    const extension = taskLifecycleKey(identity("t1", { wire: "extension" }));
    expect(legacy).not.toBe(extension);
  });

  it("keeps the auth scope in the key", () => {
    expect(taskLifecycleKey(identity("t1", { scope: "projA" }))).not.toBe(
      taskLifecycleKey(identity("t1", { scope: "projB" }))
    );
  });
});

describe("poll interval resolution", () => {
  it("takes the MAXIMUM of the server floor and the user minimum, never the user's alone", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({
      now: clock.now,
      userMinimumIntervalMs: 500,
    });
    const id = identity("t1");
    engine.observe(id, { status: "working", pollIntervalMs: 5_000 });

    const record = engine.get(id)!;
    // The old `userOverride ?? serverSuggested ?? userDefault` chain would have
    // produced 500 here and hammered the server ten times per advertised tick.
    expect(engine.effectiveIntervalMs(record)).toBe(5_000);
  });

  it("honors a user minimum that is SLOWER than the server floor", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({
      now: clock.now,
      userMinimumIntervalMs: 30_000,
    });
    const id = identity("t1");
    engine.observe(id, { status: "working", pollIntervalMs: 1_000 });
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(30_000);
  });

  it("accepts a poll interval that SHRINKS mid-task without flagging it", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({ now: clock.now });
    const id = identity("t1");

    engine.observe(id, { status: "working", pollIntervalMs: 10_000 });
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(10_000);

    clock.advance(10_000);
    // `pollIntervalMs` MAY change in either direction (tasks.md:308).
    engine.observe(id, { status: "working", pollIntervalMs: 2_000 });
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(2_000);
  });

  it("backs off exponentially on consecutive errors and resets on a good read", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({
      now: clock.now,
      errorBackoffBaseMs: 1_000,
      absoluteFloorMs: 100,
    });
    const id = identity("t1");
    engine.register(id);

    engine.observeError(id);
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(1_000);
    engine.observeError(id);
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(2_000);
    engine.observeError(id);
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(4_000);

    engine.observe(id, { status: "working" });
    expect(engine.get(id)!.consecutiveErrors).toBe(0);
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(100);
  });

  it("caps the backoff", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({
      now: clock.now,
      errorBackoffBaseMs: 1_000,
      errorBackoffMaxMs: 5_000,
    });
    const id = identity("t1");
    for (let i = 0; i < 20; i += 1) engine.observeError(id);
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(5_000);
  });

  it("lets Retry-After win over every other term while it is in force", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({ now: clock.now });
    const id = identity("t1");
    engine.observe(id, { status: "working", pollIntervalMs: 1_000 });

    engine.applyRetryAfter(id, 45_000);
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(45_000);

    // It decays as real time passes rather than staying pinned.
    clock.advance(40_000);
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(5_000);
    clock.advance(10_000);
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(1_000);
  });

  it("ignores a NaN / negative / infinite pollIntervalMs from a server", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({
      now: clock.now,
      absoluteFloorMs: 250,
    });
    const id = identity("t1");
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      engine.observe(id, { status: "working", pollIntervalMs: bad });
      expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(250);
    }
  });

  it("clamps a hostile pollIntervalMs to the maximum so a task cannot be parked forever", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({
      now: clock.now,
      maximumIntervalMs: 60_000,
    });
    const id = identity("t1");
    engine.observe(id, { status: "working", pollIntervalMs: 999_999_999 });
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(60_000);
  });
});

describe("per-task scheduling", () => {
  it("does not let a fast task drag a slow task below its own floor", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({ now: clock.now });
    const fast = identity("fast");
    const slow = identity("slow");

    engine.observe(fast, { status: "working", pollIntervalMs: 1_000 });
    engine.observe(slow, { status: "working", pollIntervalMs: 10_000 });

    clock.advance(1_000);
    expect(engine.due().map((r) => r.identity.taskId)).toEqual(["fast"]);

    clock.advance(1_000);
    engine.observe(fast, { status: "working", pollIntervalMs: 1_000 });
    clock.advance(1_000);
    // The slow task is still not due, 3s in, even though the fast one has been
    // polled twice. The old shared-`Math.min` scheduler polled both every 1s.
    expect(engine.due().map((r) => r.identity.taskId)).toEqual(["fast"]);

    clock.advance(7_000);
    expect(engine.due().map((r) => r.identity.taskId).sort()).toEqual([
      "fast",
      "slow",
    ]);
  });

  it("gives a batch the SLOWEST member's floor, not the fastest", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({ now: clock.now });
    const a = identity("a");
    const b = identity("b");
    engine.observe(a, { status: "working", pollIntervalMs: 1_000 });
    engine.observe(b, { status: "working", pollIntervalMs: 9_000 });

    const batch = [engine.get(a)!, engine.get(b)!];
    expect(engine.batchIntervalMs(batch)).toBe(9_000);
  });

  it("never reports a terminal task as due", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({ now: clock.now });
    const id = identity("t1");
    engine.observe(id, { status: "completed", result: { ok: true } });
    clock.advance(1_000_000);
    expect(engine.due()).toEqual([]);
    expect(engine.msUntilNextDue()).toBeUndefined();
  });

  it("reserve() pushes a dispatched task forward so a tick cannot double-issue it", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({ now: clock.now });
    const id = identity("t1");
    engine.observe(id, { status: "working", pollIntervalMs: 5_000 });
    clock.advance(5_000);

    const due = engine.due();
    expect(due).toHaveLength(1);
    engine.reserve(due);
    expect(engine.due()).toEqual([]);
  });

  it("applies a slower user minimum to already-scheduled tasks immediately", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({ now: clock.now });
    const id = identity("t1");
    engine.observe(id, { status: "working", pollIntervalMs: 1_000 });
    expect(engine.msUntilNextDue()).toBe(1_000);

    engine.setUserMinimumIntervalMs(20_000);
    expect(engine.msUntilNextDue()).toBe(20_000);
  });
});

describe("state transitions", () => {
  it("announces creation once and does not re-announce a restored handle", () => {
    const created: string[] = [];
    const engine = new TaskLifecycleEngine({
      callbacks: { onTaskCreated: (r) => created.push(r.identity.taskId) },
    });
    engine.register(identity("t1"));
    engine.register(identity("t1"));
    engine.register(identity("t2"), { restored: true });
    expect(created).toEqual(["t1"]);
  });

  it("does not reset an existing handle's schedule on re-registration", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({ now: clock.now });
    const id = identity("t1");
    engine.observe(id, { status: "working", pollIntervalMs: 10_000 });
    const scheduled = engine.get(id)!.nextPollAt;

    clock.advance(1_000);
    engine.register(id);
    expect(engine.get(id)!.nextPollAt).toBe(scheduled);
  });

  it("fires terminal exactly once per handle", () => {
    const terminal: string[] = [];
    const engine = new TaskLifecycleEngine({
      callbacks: { onTerminal: (r) => terminal.push(r.status) },
    });
    const id = identity("t1");
    engine.observe(id, { status: "working" });
    engine.observe(id, { status: "completed", result: {} });
    engine.observe(id, { status: "completed", result: {} });
    expect(terminal).toEqual(["completed"]);
  });

  it("re-announces input_required when the keyed snapshot changes, not only on entry", () => {
    const seen: TaskLifecycleSnapshot[] = [];
    const engine = new TaskLifecycleEngine({
      callbacks: { onInputRequired: (r) => seen.push(r) },
    });
    const id = identity("t1");
    engine.observe(id, {
      status: "input_required",
      inputRequests: { a: { method: "elicitation/create" } } as never,
    });
    engine.observe(id, {
      status: "input_required",
      inputRequests: {
        a: { method: "elicitation/create" },
        b: { method: "elicitation/create" },
      } as never,
    });
    expect(seen).toHaveLength(2);
  });

  it("treats a null ttlMs as meaningful and lets it overwrite a number", () => {
    const engine = new TaskLifecycleEngine();
    const id = identity("t1");
    engine.observe(id, { status: "working", ttlMs: 60_000 });
    expect(engine.get(id)!.ttlMs).toBe(60_000);
    engine.observe(id, { status: "working", ttlMs: null });
    expect(engine.get(id)!.ttlMs).toBeNull();
  });

  it("leaves the status alone when a read fails — a transport error is not a task state", () => {
    const engine = new TaskLifecycleEngine();
    const id = identity("t1");
    engine.observe(id, { status: "working" });
    engine.observeError(id);
    expect(engine.get(id)!.status).toBe("working");
  });

  it("keeps polling after a cancel is requested — the ack says nothing about the task's fate", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({ now: clock.now });
    const id = identity("t1");
    engine.observe(id, { status: "working", pollIntervalMs: 1_000 });
    engine.markCancellationRequested(id);

    expect(engine.get(id)!.cancellationRequested).toBe(true);
    expect(engine.get(id)!.status).toBe("working");
    clock.advance(1_000);
    expect(engine.due()).toHaveLength(1);
  });

  it("expiry is terminal and stops the schedule", () => {
    const clock = fakeClock();
    const terminal: string[] = [];
    const engine = new TaskLifecycleEngine({
      now: clock.now,
      callbacks: { onTerminal: (r) => terminal.push(r.status) },
    });
    const id = identity("t1");
    engine.observe(id, { status: "working" });
    engine.markExpired(id);

    expect(engine.get(id)!.status).toBe("expired");
    expect(isTerminalLifecycleStatus("expired")).toBe(true);
    clock.advance(1_000_000);
    expect(engine.due()).toEqual([]);
    expect(terminal).toEqual(["expired"]);
  });
});

describe("input keys", () => {
  it("only marks a key responded when told to — after the update was acknowledged", () => {
    const engine = new TaskLifecycleEngine();
    const id = identity("t1");
    engine.observe(id, {
      status: "input_required",
      inputRequests: {
        a: { method: "elicitation/create" },
        b: { method: "elicitation/create" },
      } as never,
    });
    expect(engine.pendingInputKeys(id).sort()).toEqual(["a", "b"]);

    engine.markInputKeysResponded(id, ["a"]);
    expect(engine.pendingInputKeys(id)).toEqual(["b"]);
  });

  it("keeps responded keys across a re-sent snapshot so a reload does not re-prompt", () => {
    const engine = new TaskLifecycleEngine();
    const id = identity("t1");
    const snapshot = {
      status: "input_required" as const,
      inputRequests: { a: { method: "elicitation/create" } } as never,
    };
    engine.observe(id, snapshot);
    engine.markInputKeysResponded(id, ["a"]);
    engine.observe(id, snapshot);
    expect(engine.pendingInputKeys(id)).toEqual([]);
  });

  it("restores responded keys from durable storage", () => {
    const engine = new TaskLifecycleEngine();
    const id = identity("t1");
    engine.register(id, { restored: true, respondedInputKeys: ["a"] });
    engine.observe(id, {
      status: "input_required",
      inputRequests: {
        a: { method: "elicitation/create" },
        b: { method: "elicitation/create" },
      } as never,
    });
    expect(engine.pendingInputKeys(id)).toEqual(["b"]);
  });

  it("treats a prototype-chain key as data, not behavior", () => {
    const engine = new TaskLifecycleEngine();
    const id = identity("t1");
    engine.observe(id, {
      status: "input_required",
      inputRequests: JSON.parse(
        '{"constructor":{"method":"elicitation/create"}}'
      ) as never,
    });
    expect(engine.pendingInputKeys(id)).toEqual(["constructor"]);
  });
});

describe("wire adapters", () => {
  it("normalizes an extension completed task, keeping the raw payload", () => {
    const task = {
      taskId: "t1",
      status: "completed" as const,
      createdAt: "2026-07-28T00:00:00Z",
      lastUpdatedAt: "2026-07-28T00:01:00Z",
      ttlMs: null,
      result: { content: [], isError: true },
    };
    const observation = extensionTaskToObservation(task);
    // `isError: true` is a COMPLETED task, not a failed one.
    expect(observation.status).toBe("completed");
    expect(observation.result).toEqual({ content: [], isError: true });
    expect(observation.error).toBeUndefined();
    expect(observation.raw).toBe(task);
  });

  it("normalizes the legacy wire's ttl / pollInterval field names", () => {
    const observation = legacyTaskToObservation({
      taskId: "t1",
      status: "working",
      ttl: 30_000,
      pollInterval: 2_000,
    } as never);
    expect(observation.ttlMs).toBe(30_000);
    expect(observation.pollIntervalMs).toBe(2_000);
  });

  it("keeps an unrecognized legacy status pollable rather than inventing a terminal state", () => {
    const observation = legacyTaskToObservation({
      taskId: "t1",
      status: "who-knows",
    } as never);
    expect(observation.status).toBe("working");
  });

  it("recognizes the unknown-task error in both nested and flat shapes", () => {
    expect(isUnknownTaskError({ code: -32602 })).toBe(true);
    expect(isUnknownTaskError({ error: { code: -32602 } })).toBe(true);
    expect(isUnknownTaskError({ code: -32003 })).toBe(false);
    expect(isUnknownTaskError(null)).toBe(false);
  });

  it("parses Retry-After as both a delta and an HTTP date, and rejects garbage", () => {
    const now = Date.parse("2026-07-28T00:00:00Z");
    expect(parseRetryAfterMs("30", now)).toBe(30_000);
    expect(parseRetryAfterMs("2026-07-28T00:00:45Z", now)).toBe(45_000);
    // A malformed hint must not become a zero-length backoff.
    expect(parseRetryAfterMs("soon", now)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
  });
});
