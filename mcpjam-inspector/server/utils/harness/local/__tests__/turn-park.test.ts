import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimLocalTurnPark,
  claimParkedLocalSession,
  describeParkedLocalSession,
  hasLocalTurnPark,
  invalidateLocalTurnParks,
  MAX_TURN_PARKS,
  noteParkedLocalSessionEnded,
  parkLocalSession,
  parkLocalTurn,
  releaseParkedLocalSession,
  resetApprovalParkForTests,
  shutdownLocalTurnParks,
  TURN_PARK_LIFETIME_MS,
} from "../approval-park.js";

/**
 * A Codex runtime kept between turns: the same registry as an approval park,
 * adopted only by the conversation's next turn for exactly the committed
 * state it belongs to, and bounded by idle TTL, lifetime and a cap.
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

const MINUTE = 60_000;

function keep(overrides: Partial<Parameters<typeof parkLocalTurn>[0]> = {}) {
  const end = vi.fn(async (_reason: string) => {});
  const hold = vi.fn();
  let alive = true;
  const kept = parkLocalTurn({
    sessionId: "s1",
    generation: "gen-1",
    userId: "u1",
    projectId: "p1",
    harnessId: "codex",
    runtimeDigest: "sha256:pack-1",
    stateVersion: 2,
    fingerprint: "config-a",
    resources: { live: true },
    end,
    isAlive: () => alive,
    holdModelTraffic: hold,
    ...overrides,
  });
  return { kept, end, hold, kill: () => (alive = false) };
}

const claim = (overrides: Partial<Parameters<typeof claimLocalTurnPark>[0]> = {}) =>
  claimLocalTurnPark({
    sessionId: "s1",
    generation: "gen-1",
    stateVersion: 2,
    fingerprint: "config-a",
    userId: "u1",
    projectId: "p1",
    ...overrides,
  });

describe("keeping a runtime between turns", () => {
  it("holds model traffic the moment it is kept, and waits idle", () => {
    const { kept, hold } = keep();
    expect(kept).toBe(true);
    expect(hold).toHaveBeenCalledOnce();
    expect(hasLocalTurnPark("s1")).toBe(true);
    expect(describeParkedLocalSession("s1")).toMatchObject({ state: "idle", pendingApprovalIds: [] });
  });

  it("is adopted by the next turn for the same generation, state version and configuration", () => {
    keep();
    const adopted = claim();
    expect(adopted.ok).toBe(true);
    expect(describeParkedLocalSession("s1")?.state).toBe("continuing");
    // Exactly once.
    expect(claim()).toEqual({ ok: false, reason: "not-idle" });
  });

  it.each([
    ["another generation", { generation: "gen-2" }, "stale"],
    ["a state version a turn elsewhere moved on", { stateVersion: 3 }, "stale"],
    ["another configuration", { fingerprint: "config-b" }, "configuration-changed"],
    ["another user", { userId: "u2" }, "actor-mismatch"],
    ["another project", { projectId: "p2" }, "actor-mismatch"],
  ] as const)("refuses %s", (_label, overrides, reason) => {
    keep();
    expect(claim(overrides)).toEqual({ ok: false, reason });
    // Refused claims change nothing: the caller decides how the park ends.
    expect(describeParkedLocalSession("s1")?.state).toBe("idle");
  });

  it("refuses a runtime whose process died", () => {
    const { kill } = keep();
    kill();
    expect(claim()).toEqual({ ok: false, reason: "process-died" });
  });

  it("is not what an approval decision can claim", () => {
    keep();
    expect(
      claimParkedLocalSession({ sessionId: "s1", generation: "gen-1", userId: "u1", projectId: "p1", approvalIds: ["a1"] }),
    ).toMatchObject({ ok: false, reason: "absent" });
  });

  it("ends after 15 idle minutes", async () => {
    const { end } = keep();
    advance(15 * MINUTE - 1);
    expect(end).not.toHaveBeenCalled();
    advance(1);
    await vi.waitFor(() => expect(end).toHaveBeenCalledWith("idle-expired"));
    expect(claim()).toEqual({ ok: false, reason: "terminal" });
  });

  it("stops answering the moment Stop ends the session", () => {
    keep();
    noteParkedLocalSessionEnded("s1");
    expect(claim()).toEqual({ ok: false, reason: "terminal" });
    expect(hasLocalTurnPark("s1")).toBe(false);
  });

  it("keeps its first creation time across turns, and is not kept past its lifetime", () => {
    const end = vi.fn(async (_reason: string) => {});
    keep({ end });
    // Used every ten minutes: never idle long enough to expire.
    for (let turn = 1; turn * 10 * MINUTE < TURN_PARK_LIFETIME_MS; turn += 1) {
      expect(claim().ok).toBe(true);
      advance(10 * MINUTE);
      expect(keep({ end }).kept).toBe(true);
    }
    // A turn that runs across the lifetime is never ended for it...
    expect(claim().ok).toBe(true);
    advance(10 * MINUTE);
    expect(end).not.toHaveBeenCalled();
    // ...it is just not kept again.
    expect(keep({ end }).kept).toBe(false);
  });

  it("ends an idle runtime at its lifetime, ahead of its idle TTL", async () => {
    const end = vi.fn(async (_reason: string) => {});
    keep({ end });
    for (let turn = 0; turn < 23; turn += 1) {
      expect(claim().ok).toBe(true);
      advance(10 * MINUTE);
      keep({ end });
    }
    // 230 minutes old: 10 minutes of life left, less than the idle TTL.
    advance(10 * MINUTE);
    await vi.waitFor(() => expect(end).toHaveBeenCalledWith("lifetime"));
  });

  it("refuses a claim past the lifetime even if the timer has not fired", () => {
    keep();
    now += TURN_PARK_LIFETIME_MS;
    expect(claim()).toEqual({ ok: false, reason: "lifetime" });
  });
});

describe("at most four kept runtimes", () => {
  it("evicts the least recently used idle one, skipping a turn in progress", async () => {
    const ends = new Map<string, ReturnType<typeof vi.fn>>();
    for (let index = 1; index <= MAX_TURN_PARKS; index += 1) {
      advance(1);
      const { end } = keep({ sessionId: `s${index}`, generation: `gen-${index}` });
      ends.set(`s${index}`, end);
    }
    // s1 is the oldest, but a turn is using it.
    expect(claim({ sessionId: "s1" }).ok).toBe(true);
    advance(1);
    expect(keep({ sessionId: "s5", generation: "gen-5" }).kept).toBe(true);
    await vi.waitFor(() => expect(ends.get("s2")).toHaveBeenCalledWith("evicted"));
    expect(ends.get("s1")).not.toHaveBeenCalled();
    expect(hasLocalTurnPark("s1")).toBe(true);
    expect(hasLocalTurnPark("s5")).toBe(true);
  });

  it("keeps nothing more while every slot is a turn in progress", () => {
    for (let index = 1; index <= MAX_TURN_PARKS; index += 1) {
      keep({ sessionId: `s${index}`, generation: `gen-${index}` });
      expect(claim({ sessionId: `s${index}`, generation: `gen-${index}` }).ok).toBe(true);
    }
    expect(keep({ sessionId: "s5", generation: "gen-5" }).kept).toBe(false);
    expect(hasLocalTurnPark("s5")).toBe(false);
  });

  it("counts a runtime kept again for its next turn once", () => {
    for (let index = 1; index <= MAX_TURN_PARKS; index += 1) {
      keep({ sessionId: `s${index}`, generation: `gen-${index}` });
    }
    expect(claim({ sessionId: "s1" }).ok).toBe(true);
    const { end, kept } = keep({ sessionId: "s1" });
    expect(kept).toBe(true);
    expect(end).not.toHaveBeenCalled();
    for (let index = 2; index <= MAX_TURN_PARKS; index += 1) {
      expect(hasLocalTurnPark(`s${index}`)).toBe(true);
    }
  });
});

describe("ending kept runtimes together", () => {
  it("ends idle ones of a harness for an install, leaving a turn in progress and approvals alone", async () => {
    const idle = keep({ sessionId: "idle" });
    const busy = keep({ sessionId: "busy" });
    const other = keep({ sessionId: "other", harnessId: "copilot-cli" });
    expect(claim({ sessionId: "busy" }).ok).toBe(true);
    const approvalEnd = vi.fn(async () => {});
    parkLocalSession({
      sessionId: "approval", generation: "g", userId: "u1", projectId: "p1",
      pendingApprovalIds: ["a1"], resources: {}, end: approvalEnd, isAlive: () => true, holdModelTraffic: vi.fn(),
    });
    await invalidateLocalTurnParks("runtime-update", { which: (kept) => kept.harnessId === "codex" });
    expect(idle.end).toHaveBeenCalledWith("runtime-update");
    expect(busy.end).not.toHaveBeenCalled();
    expect(other.end).not.toHaveBeenCalled();
    expect(approvalEnd).not.toHaveBeenCalled();
  });

  it("ends only the idle ones on the pack it names", async () => {
    const onOld = keep({ sessionId: "old", runtimeDigest: "sha256:old" });
    const onNew = keep({ sessionId: "new", runtimeDigest: "sha256:new" });
    await invalidateLocalTurnParks("runtime-update", { which: (kept) => kept.runtimeDigest === "sha256:old" });
    expect(onOld.end).toHaveBeenCalledWith("runtime-update");
    expect(onNew.end).not.toHaveBeenCalled();
  });

  it("stops every kept runtime at Inspector shutdown, a turn in progress included", async () => {
    const idle = keep({ sessionId: "idle" });
    const busy = keep({ sessionId: "busy" });
    expect(claim({ sessionId: "busy" }).ok).toBe(true);
    await shutdownLocalTurnParks();
    expect(idle.end).toHaveBeenCalledWith("shutdown");
    expect(busy.end).toHaveBeenCalledWith("shutdown");
  });

  it("releases a record only for the runtime it holds", () => {
    const resources = { live: true };
    keep({ resources });
    releaseParkedLocalSession("s1", { live: true });
    expect(hasLocalTurnPark("s1")).toBe(true);
    releaseParkedLocalSession("s1", resources);
    expect(hasLocalTurnPark("s1")).toBe(false);
  });
});
