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
  retryAfterMsFromError,
} from "../src/mcp-client-manager/task-lifecycle-adapters.js";

const identity = (
  taskId: string,
  overrides: Partial<TaskLifecycleIdentity> = {}
): TaskLifecycleIdentity => ({
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
  it("lets a LOWERED user minimum shorten a wait it caused", () => {
    const clock = { at: 1_000 };
    const engine = new TaskLifecycleEngine({
      now: () => clock.at,
      userMinimumIntervalMs: 60_000,
    });
    const identity = {
      serverId: "s",
      wire: "extension",
      taskId: "t1",
    } as const;
    engine.observe(identity, { status: "working", pollIntervalMs: 2_000 });
    expect(engine.get(identity)!.nextPollAt).toBe(clock.at + 60_000);

    // A blanket "never earlier" kept the superseded preference as if it were a
    // server wait: the task stayed parked for the rest of its old 60s, so the
    // new setting did nothing until it happened to come due.
    engine.setUserMinimumIntervalMs(1_000);
    // Back down to the SERVER's floor, not to the user's 1s — the preference
    // is one `max` term, never permission to poll faster than asked.
    expect(engine.get(identity)!.nextPollAt).toBe(clock.at + 2_000);
  });

  it("does not let a lowered minimum punch through a Retry-After", () => {
    const clock = { at: 1_000 };
    const engine = new TaskLifecycleEngine({
      now: () => clock.at,
      userMinimumIntervalMs: 60_000,
    });
    const identity = {
      serverId: "s",
      wire: "extension",
      taskId: "t1",
    } as const;
    engine.observe(identity, { status: "working", pollIntervalMs: 2_000 });
    engine.applyRetryAfter(identity, 120_000);
    const deadline = engine.get(identity)!.nextPollAt;

    // A wait the SERVER imposed is absolute and survives the recompute; only
    // the part the old preference caused is recoverable.
    engine.setUserMinimumIntervalMs(1_000);
    expect(engine.get(identity)!.nextPollAt).toBe(deadline);
  });

  it("does not let a lowered minimum walk through an error backoff", () => {
    const clock = { at: 1_000 };
    const engine = new TaskLifecycleEngine({
      now: () => clock.at,
      userMinimumIntervalMs: 60_000,
    });
    const identity = {
      serverId: "s",
      wire: "extension",
      taskId: "t1",
    } as const;
    engine.observe(identity, { status: "working", pollIntervalMs: 2_000 });
    clock.at += 60_000;
    engine.observeError(identity);
    const backedOffTo = engine.get(identity)!.nextPollAt;
    expect(backedOffTo).toBeGreaterThan(clock.at);

    engine.setUserMinimumIntervalMs(1_000);
    expect(engine.get(identity)!.nextPollAt).toBe(backedOffTo);
  });

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

  it("does NOT clamp a long server floor — the cap governs only local terms", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({
      now: clock.now,
      maximumIntervalMs: 60_000,
    });
    const id = identity("t1");
    // A server asking to be polled every ten minutes has said something we are
    // obliged to respect. Clamping to a local 60s would mean polling ten times
    // more often than instructed — a deliberate SHOULD violation. The tradeoff
    // is accepted: a task parked by an absurd floor is still refreshable by
    // hand, and its handle is still tracked.
    engine.observe(id, { status: "working", pollIntervalMs: 600_000 });
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(600_000);
  });

  it("does NOT clamp a Retry-After longer than the maximum interval", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({
      now: clock.now,
      maximumIntervalMs: 60_000,
    });
    const id = identity("t1");
    engine.observe(id, { status: "working" });
    engine.applyRetryAfter(id, 600_000);
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(600_000);

    // And it still decays with real time rather than staying pinned: 50s of
    // the hint remain, which is below the cap but above every local term.
    clock.advance(550_000);
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(50_000);
  });

  it("still clamps the LOCAL terms — a runaway backoff cannot park a task", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({
      now: clock.now,
      maximumIntervalMs: 5_000,
      errorBackoffBaseMs: 1_000,
      errorBackoffMaxMs: 10 * 60_000,
    });
    const id = identity("t1");
    for (let i = 0; i < 20; i += 1) engine.observeError(id);
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(5_000);
  });

  it("treats a non-finite user minimum as zero rather than poisoning the schedule", () => {
    const clock = fakeClock();
    // `Math.max(0, NaN)` is NaN, and a NaN interval makes every `nextPollAt`
    // comparison false — one malformed preference would silently stop ALL
    // polling instead of failing loudly.
    const engine = new TaskLifecycleEngine({
      now: clock.now,
      userMinimumIntervalMs: Number.NaN,
      absoluteFloorMs: 250,
    });
    const id = identity("t1");
    engine.observe(id, { status: "working" });
    expect(engine.effectiveIntervalMs(engine.get(id)!)).toBe(250);
    expect(Number.isFinite(engine.get(id)!.nextPollAt)).toBe(true);

    engine.setUserMinimumIntervalMs(Number.NaN);
    expect(Number.isFinite(engine.get(id)!.nextPollAt)).toBe(true);
  });

  it("a slower preference never shortens a wait the server asked for", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({ now: clock.now });
    const id = identity("t1");
    engine.observe(id, { status: "working" });
    engine.applyRetryAfter(id, 120_000);
    const reserved = engine.get(id)!.nextPollAt;

    // Recomputing from `lastObservedAt` would land in the past here, punching
    // straight through the Retry-After.
    engine.setUserMinimumIntervalMs(1_000);
    expect(engine.get(id)!.nextPollAt).toBeGreaterThanOrEqual(reserved);
  });
});

describe("per-task scheduling", () => {
  it("excludes a leased handle from `due` for the whole read", () => {
    const clock = { at: 1_000 };
    const engine = new TaskLifecycleEngine({ now: () => clock.at });
    const identity = {
      serverId: "s",
      wire: "extension",
      taskId: "t1",
    } as const;
    engine.observe(identity, { status: "working", pollIntervalMs: 1_000 });

    clock.at += 5_000;
    expect(engine.due().map((r) => r.identity.taskId)).toEqual(["t1"]);

    expect(engine.acquirePoll(identity)).toBe(true);
    // A second acquirer is refused rather than dispatching on top of the
    // first: two `tasks/get` in flight means the later reply wins even when it
    // observed the older state.
    expect(engine.acquirePoll(identity)).toBe(false);

    // Time alone does NOT re-admit it. That is the whole difference between a
    // lease and `reserve`: a read slower than its own floor would otherwise
    // read as due again while still open.
    clock.at += 10 * 60_000;
    expect(engine.due()).toEqual([]);

    engine.releasePoll(identity);
    expect(engine.due().map((r) => r.identity.taskId)).toEqual(["t1"]);
  });

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
    expect(
      engine
        .due()
        .map((r) => r.identity.taskId)
        .sort()
    ).toEqual(["fast", "slow"]);
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

  it("clears the error backoff for a user-initiated read, keeping the server's floor", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({ now: clock.now });
    const id = identity("t1");
    engine.observe(id, { status: "working", pollIntervalMs: 1_000 });
    engine.observeError(id);
    engine.observeError(id);
    engine.observeError(id);
    // Backed off well past the server's own floor: without this, a person
    // clicking Refresh watches nothing happen.
    expect(engine.msUntilNextDue()).toBeGreaterThan(1_000);

    clock.advance(500);
    engine.clearErrorBackoff(id);
    expect(engine.get(id)?.consecutiveErrors).toBe(0);
    // The SERVER's floor survives — 1s from the last observation, of which
    // 500ms has elapsed — so a click cannot out-poll what the server asked for.
    expect(engine.msUntilNextDue()).toBe(500);
  });

  it("never lets a cleared backoff punch through a Retry-After", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({ now: clock.now });
    const id = identity("t1");
    engine.observe(id, { status: "working" });
    engine.applyRetryAfter(id, 30_000);
    engine.observeError(id);

    engine.clearErrorBackoff(id);
    // Rate limiting is the server's explicit instruction, not our guess.
    expect(engine.msUntilNextDue()).toBe(30_000);
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

describe("terminal finality", () => {
  it("applies the first observation to a RESTORED terminal handle", () => {
    const engine = new TaskLifecycleEngine();
    const identity = {
      serverId: "s",
      wire: "extension",
      taskId: "t1",
    } as const;
    // Storage kept the status and nothing else — it never holds the payload,
    // and on the extension wire the result rides inline on `tasks/get`, so
    // this read is the only way the result is ever obtained.
    engine.register(identity, { restored: true, status: "completed" });
    engine.observe(identity, {
      status: "completed",
      result: { content: [{ type: "text", text: "done" }] },
    });
    expect(engine.get(identity)?.result).toEqual({
      content: [{ type: "text", text: "done" }],
    });
    expect(engine.get(identity)?.restored).toBe(false);
  });

  it("still treats an OBSERVED terminal as final", () => {
    const engine = new TaskLifecycleEngine();
    const identity = {
      serverId: "s",
      wire: "extension",
      taskId: "t1",
    } as const;
    engine.observe(identity, { status: "completed", result: { a: 1 } });
    // A poll issued before the terminal landed can answer after it. Applying
    // it would revert a finished task's UI and scheduling to `working`.
    engine.observe(identity, { status: "working" });
    expect(engine.get(identity)?.status).toBe("completed");
    expect(engine.get(identity)?.result).toEqual({ a: 1 });
  });

  it("ignores a late poll that would reanimate a terminal task", () => {
    const engine = new TaskLifecycleEngine();
    const id = identity("t1");
    // A notification lands first; the poll that was already in flight lands
    // after it. Applying the stale poll would revert completed UI to working.
    engine.observe(
      id,
      { status: "completed", result: { ok: true } },
      "notification"
    );
    engine.observe(id, { status: "working" }, "poll");

    expect(engine.get(id)!.status).toBe("completed");
    expect(engine.get(id)!.result).toEqual({ ok: true });
  });

  it("still advances the observation clock for a late poll", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({ now: clock.now });
    const id = identity("t1");
    engine.observe(id, { status: "completed", result: {} });
    const first = engine.get(id)!.lastObservedAt;

    clock.advance(5_000);
    engine.observe(id, { status: "working" });
    // The handle demonstrably still exists, which is what the retention clock
    // cares about — even though its state is final.
    expect(engine.get(id)!.lastObservedAt).toBeGreaterThan(first!);
  });
});

describe("observation bookkeeping", () => {
  it("lets a server clear a status message by omitting it", () => {
    const engine = new TaskLifecycleEngine();
    const id = identity("t1");
    engine.observe(id, { status: "working", statusMessage: "step 1 of 3" });
    expect(engine.get(id)!.statusMessage).toBe("step 1 of 3");

    // An observation is a FULL snapshot: omitting the field clears it, rather
    // than leaving a stale message describing a resolved condition.
    engine.observe(id, { status: "working" });
    expect(engine.get(id)!.statusMessage).toBeUndefined();
  });

  it("a notification does not clear the POLL path's backoff", () => {
    const clock = fakeClock();
    const engine = new TaskLifecycleEngine({
      now: clock.now,
      errorBackoffBaseMs: 1_000,
    });
    const id = identity("t1");
    engine.observeError(id);
    engine.observeError(id);
    expect(engine.get(id)!.consecutiveErrors).toBe(2);

    // Notifications arrive on a different channel; one says nothing about
    // whether `tasks/get` recovered.
    engine.observe(id, { status: "working" }, "notification");
    expect(engine.get(id)!.consecutiveErrors).toBe(2);

    // A successful READ is what proves it.
    engine.observe(id, { status: "working" }, "poll");
    expect(engine.get(id)!.consecutiveErrors).toBe(0);
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
    expect(isUnknownTaskError({ code: -32021 })).toBe(false);
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

describe("retryAfterMsFromError", () => {
  const now = Date.parse("2026-07-28T00:00:00Z");

  it("reads each error shape a layer might preserve, most-explicit first", () => {
    expect(retryAfterMsFromError({ retryAfterMs: 1_500 }, now)).toBe(1_500);
    // `retryAfter` follows the platform-error convention: seconds.
    expect(retryAfterMsFromError({ retryAfter: 30 }, now)).toBe(30_000);
    expect(retryAfterMsFromError({ retryAfter: "30" }, now)).toBe(30_000);
    expect(
      retryAfterMsFromError({ headers: { "retry-after": "30" } }, now)
    ).toBe(30_000);
    // HTTP field names are case-insensitive (RFC 9110 §5.1) — any casing on a
    // plain record must be found.
    expect(
      retryAfterMsFromError({ headers: { "RETRY-AFTER": "30" } }, now)
    ).toBe(30_000);
    expect(
      retryAfterMsFromError({ headers: { "Retry-After": "30" } }, now)
    ).toBe(30_000);
    expect(
      retryAfterMsFromError(
        { headers: new Headers({ "Retry-After": "30" }) },
        now
      )
    ).toBe(30_000);
    expect(
      retryAfterMsFromError(
        { response: { headers: { "Retry-After": "2026-07-28T00:00:45Z" } } },
        now
      )
    ).toBe(45_000);
  });

  it("matches record header names in any casing", () => {
    // HTTP header names are case-insensitive and this branch reads a record
    // some unknown layer preserved, so no single spelling can be assumed.
    // Missing the hint is not cosmetic: the poll loop loses its floor and
    // hammers a server that just asked it to wait.
    for (const name of [
      "retry-after",
      "Retry-After",
      "RETRY-AFTER",
      "Retry-after",
      "rEtRy-AfTeR",
    ]) {
      expect(retryAfterMsFromError({ headers: { [name]: "30" } }, now)).toBe(
        30_000
      );
    }
    // Node types multi-valued header records as `string[]`; a preserved record
    // may carry that shape even though `Retry-After` is single-valued.
    expect(
      retryAfterMsFromError({ headers: { "Retry-After": ["30"] } }, now)
    ).toBe(30_000);
  });

  it("returns undefined when nothing usable is attached", () => {
    expect(retryAfterMsFromError(new Error("plain"), now)).toBeUndefined();
    expect(retryAfterMsFromError(undefined, now)).toBeUndefined();
    expect(retryAfterMsFromError("string error", now)).toBeUndefined();
    // A malformed hint must not become a zero-length floor.
    expect(
      retryAfterMsFromError({ headers: { "retry-after": "soon" } }, now)
    ).toBeUndefined();
    expect(retryAfterMsFromError({ retryAfterMs: -5 }, now)).toBeUndefined();
  });
});
