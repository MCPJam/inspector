import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimParkedLocalSession,
  describeParkedLocalSession,
  hasParkedLocalSession,
  invalidateParkedLocalSession,
  noteParkedLocalSessionEnded,
  parkLocalSession,
  releaseParkedLocalSession,
  resetApprovalParkForTests,
} from "../approval-park.js";

/**
 * D7 — the parked-approval lifecycle, as a state machine with a controllable
 * clock. What a real Codex session needs from it: a pending decision belongs
 * to ONE live process generation and ONE approval request, is delivered once,
 * and every way the session can end invalidates it.
 */

type Timer = { fn: () => void; at: number; cleared: boolean };

let now = 0;
let timers: Timer[] = [];

function advance(ms: number) {
  now += ms;
  for (const timer of [...timers]) {
    if (!timer.cleared && timer.at <= now) {
      timer.cleared = true;
      timer.fn();
    }
  }
}

beforeEach(() => {
  now = 1_000;
  timers = [];
  resetApprovalParkForTests({
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: now + ms, cleared: false };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (timer) => {
      (timer as unknown as Timer).cleared = true;
    },
  });
});

afterEach(() => resetApprovalParkForTests());

function park(overrides: Partial<Parameters<typeof parkLocalSession>[0]> = {}) {
  const end = vi.fn(async () => {});
  const hold = vi.fn();
  let alive = true;
  const parked = parkLocalSession({
    sessionId: "s1",
    generation: "gen-1",
    userId: "u1",
    projectId: "p1",
    pendingApprovalIds: ["a1"],
    resources: { live: true },
    end,
    isAlive: () => alive,
    holdModelTraffic: hold,
    ttlMs: 60_000,
    ...overrides,
  });
  return { parked, end, hold, kill: () => (alive = false) };
}

const claim = (overrides: Partial<Parameters<typeof claimParkedLocalSession>[0]> = {}) =>
  claimParkedLocalSession({
    sessionId: "s1",
    generation: "gen-1",
    userId: "u1",
    projectId: "p1",
    approvalIds: ["a1"],
    ...overrides,
  });

describe("parking a live runtime on an approval", () => {
  it("holds model traffic the moment it parks", () => {
    const { parked, hold } = park();
    expect(parked).toBe(true);
    expect(hold).toHaveBeenCalledOnce();
    expect(describeParkedLocalSession("s1")).toMatchObject({
      state: "awaiting-approval",
      pendingApprovalIds: ["a1"],
      expiresAt: 61_000,
    });
  });

  it("refuses a park with nothing to wait on", () => {
    expect(() => park({ pendingApprovalIds: [] })).toThrow(/at least one/);
  });
});

describe("delivering a decision", () => {
  it("hands the live runtime to exactly one decision", () => {
    park();
    const first = claim();
    expect(first).toMatchObject({ ok: true });
    expect(first.ok && first.parked.resources).toEqual({ live: true });
    // The same reply again — a double-click, a retried request — must not
    // execute the action a second time.
    expect(claim()).toMatchObject({ ok: false, reason: "duplicate-approval" });
  });

  it("refuses two racing replies for one approval: the second is a duplicate", () => {
    park();
    const results = [claim(), claim()];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({
      reason: "duplicate-approval",
    });
  });

  it("never lets an earlier pause's decision approve a later action", () => {
    park();
    expect(claim()).toMatchObject({ ok: true });
    // The continuation paused again on a NEW request in the same process.
    park({ pendingApprovalIds: ["a2"] });
    // A stale reply for a1 cannot approve a2 …
    expect(claim({ approvalIds: ["a1"] })).toMatchObject({
      ok: false,
      reason: "duplicate-approval",
    });
    // … and an id nobody asked about cannot approve anything.
    expect(claim({ approvalIds: ["a9"] })).toMatchObject({
      ok: false,
      reason: "stale-approval",
    });
    expect(claim({ approvalIds: ["a2"] })).toMatchObject({ ok: true });
  });

  it("binds a decision to the process generation that asked for it", () => {
    park();
    expect(claim({ generation: "gen-2" })).toMatchObject({
      ok: false,
      reason: "generation-mismatch",
    });
    expect(hasParkedLocalSession("s1")).toBe(true);
  });

  it("binds a decision to the user and project that own the session", () => {
    park();
    expect(claim({ userId: "u2" })).toMatchObject({
      ok: false,
      reason: "actor-mismatch",
    });
    expect(claim({ projectId: "p2" })).toMatchObject({
      ok: false,
      reason: "actor-mismatch",
    });
  });

  it("stays deliverable across a wait longer than a minute, up to its TTL", () => {
    park({ ttlMs: 30 * 60_000 });
    advance(5 * 60_000);
    expect(describeParkedLocalSession("s1")?.state).toBe("awaiting-approval");
    expect(claim()).toMatchObject({ ok: true });
  });

  it("can be reconnected to: the pending request is still described after a reload", () => {
    park();
    // A reloaded UI asks again; nothing about asking consumes the decision.
    expect(describeParkedLocalSession("s1")?.pendingApprovalIds).toEqual(["a1"]);
    expect(describeParkedLocalSession("s1")?.pendingApprovalIds).toEqual(["a1"]);
    expect(claim()).toMatchObject({ ok: true });
  });
});

describe("every way a parked session ends invalidates its decision", () => {
  it("idle expiry tears the session down and refuses the late decision", async () => {
    const { end } = park({ ttlMs: 10_000 });
    advance(10_000);
    await vi.waitFor(() => expect(end).toHaveBeenCalledWith("idle-expired"));
    expect(claim()).toMatchObject({ ok: false, reason: "terminal" });
  });

  it("Stop through the registry invalidates synchronously, before teardown", () => {
    const { end } = park();
    noteParkedLocalSessionEnded("s1");
    expect(claim()).toMatchObject({ ok: false, reason: "terminal" });
    // The registry owns that teardown; the parked record must not run a second.
    expect(end).not.toHaveBeenCalled();
  });

  it("process death is detected at the claim, ends the session, and runs nothing", async () => {
    const { end, kill } = park();
    kill();
    expect(claim()).toMatchObject({ ok: false, reason: "process-died" });
    await vi.waitFor(() => expect(end).toHaveBeenCalledWith("process-died"));
    // The decision was not consumed by a process that could not act on it, and
    // it cannot be delivered anywhere else either.
    expect(claim()).toMatchObject({ ok: false, reason: "terminal" });
  });

  it("a failed renewal after the claim ends the session; nothing is delivered", async () => {
    const { end } = park();
    expect(claim()).toMatchObject({ ok: true });
    await invalidateParkedLocalSession("s1", "renewal-failed");
    expect(end).toHaveBeenCalledWith("renewal-failed");
    expect(claim()).toMatchObject({ ok: false });
  });

  it("is idempotent: a second invalidation does not tear down twice", async () => {
    const { end } = park();
    await invalidateParkedLocalSession("s1", "stopped");
    await invalidateParkedLocalSession("s1", "idle-expired");
    expect(end).toHaveBeenCalledOnce();
  });

  it("a stop that lands while the turn is still winding down prevents the park", () => {
    park();
    noteParkedLocalSessionEnded("s1");
    // The paused turn now tries to (re-)park: it must tear down instead.
    expect(park().parked).toBe(false);
  });

  it("a stopped earlier process never refuses the next turn's park", () => {
    // Stop, then the next turn resumes the same session on a NEW process
    // (a new bridge token) and pauses on an approval of its own.
    park();
    noteParkedLocalSessionEnded("s1");
    const next = park({ generation: "gen-2", pendingApprovalIds: ["a2"] });
    expect(next.parked).toBe(true);
    expect(claim({ generation: "gen-2", approvalIds: ["a2"] })).toMatchObject({ ok: true });
  });

  it("a superseded earlier pause never refuses the next turn's park", async () => {
    // The member sends a new prompt instead of answering: the old pause is
    // invalidated, and the new turn's process pauses within the minute.
    park();
    await invalidateParkedLocalSession("s1", "superseded");
    expect(park({ generation: "gen-2", pendingApprovalIds: ["a2"] }).parked).toBe(true);
    expect(claim({ generation: "gen-2", approvalIds: ["a2"] })).toMatchObject({ ok: true });
  });

  it("a Stop leaves its record only for the tombstone window", () => {
    park();
    noteParkedLocalSessionEnded("s1");
    expect(claim()).toMatchObject({ ok: false, reason: "terminal" });
    advance(59_999);
    expect(describeParkedLocalSession("s1")).toMatchObject({ state: "terminal" });
    advance(1);
    expect(describeParkedLocalSession("s1")).toBeNull();
    expect(claim()).toMatchObject({ ok: false, reason: "absent" });
  });

  it("an absent session says so, and suggests a fresh turn", () => {
    const refused = claim({ sessionId: "nope" });
    expect(refused).toMatchObject({ ok: false, reason: "absent" });
    expect(!refused.ok && refused.message).toMatch(/Start a new turn/);
  });
});

describe("finishing a continuation", () => {
  it("returns cleanup to the turn when the continuation completes without pausing", () => {
    park();
    expect(claim()).toMatchObject({ ok: true });
    releaseParkedLocalSession("s1");
    expect(hasParkedLocalSession("s1")).toBe(false);
    // And nothing fires later.
    advance(10 * 60 * 60_000);
  });
});
