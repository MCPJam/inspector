import { describe, expect, it } from "vitest";
import { HandoffLease, RESUMED_AFTER_HANDOFF_NOTE } from "../lease";

/** A lease driven by a clock the test moves by hand. */
const atClock = (start = 1_000) => {
  let now = start;
  const lease = new HandoffLease({
    now: () => now,
    defaultTtlMs: 60_000,
    maxTtlMs: 300_000,
  });
  return {
    lease,
    advance(ms: number) {
      now += ms;
    },
  };
};

describe("HandoffLease", () => {
  it("starts free and blocks nothing", () => {
    const { lease } = atClock();
    expect(lease.state()).toEqual({ state: "free" });
    expect(lease.isBlocking()).toBe(false);
  });

  it("acquire holds it for the TTL and blocks", () => {
    const { lease } = atClock();
    const state = lease.acquire("panel-a", 30_000);
    expect(state).toEqual({
      state: "held",
      holder: "panel-a",
      expiresAt: 31_000,
    });
    expect(lease.isBlocking()).toBe(true);
  });

  it("clamps a requested TTL to the ceiling and the floor", () => {
    const { lease } = atClock();
    expect(lease.acquire("panel-a", 9_999_999)).toMatchObject({
      expiresAt: 1_000 + 300_000,
    });
    expect(lease.acquire("panel-a", -5)).toMatchObject({
      expiresAt: 1_000 + 1_000,
    });
    expect(lease.acquire("panel-a")).toMatchObject({
      expiresAt: 1_000 + 60_000,
    });
  });

  it("PARKS on expiry — it never silently frees itself", () => {
    // The whole point of L6: a timer running out is not evidence that the
    // person is done. Resuming the model underneath someone mid-login is
    // exactly the surprise the lease exists to prevent.
    const { lease, advance } = atClock();
    lease.acquire("panel-a", 30_000);
    advance(29_999);
    expect(lease.state().state).toBe("held");
    advance(1);
    expect(lease.state()).toEqual({ state: "parked", holder: "panel-a" });
    expect(lease.isBlocking()).toBe(true);
    // …and it stays parked no matter how much later anyone looks.
    advance(10 * 60 * 1000);
    expect(lease.state()).toEqual({ state: "parked", holder: "panel-a" });
  });

  it("refuses to hand a held browser to a second person", () => {
    const { lease } = atClock();
    lease.acquire("panel-a", 30_000);
    expect(lease.acquire("panel-b", 30_000)).toMatchObject({
      state: "held",
      holder: "panel-a",
    });
  });

  it("refuses to hand a PARKED browser to a second person", () => {
    // Parked means the first person may still be mid-flow; a second tab
    // taking over would show them someone else's private page.
    const { lease, advance } = atClock();
    lease.acquire("panel-a", 30_000);
    advance(30_000);
    expect(lease.acquire("panel-b")).toEqual({
      state: "parked",
      holder: "panel-a",
    });
  });

  it("lets the original holder re-acquire out of parked", () => {
    const { lease, advance } = atClock();
    lease.acquire("panel-a", 30_000);
    advance(30_000);
    expect(lease.acquire("panel-a", 30_000)).toMatchObject({
      state: "held",
      holder: "panel-a",
    });
  });

  it("heartbeat extends the holder's lease and is a no-op for anyone else", () => {
    const { lease, advance } = atClock();
    lease.acquire("panel-a", 30_000);
    advance(20_000);
    expect(lease.heartbeat("panel-a", 30_000)).toMatchObject({
      expiresAt: 21_000 + 30_000,
    });
    expect(lease.heartbeat("panel-b", 30_000)).toMatchObject({
      holder: "panel-a",
      expiresAt: 21_000 + 30_000,
    });
  });

  it("heartbeat does NOT revive a parked lease", () => {
    // Only an explicit resume ends a handoff; a stale keepalive from a tab
    // nobody is looking at must not silently re-arm the hold.
    const { lease, advance } = atClock();
    lease.acquire("panel-a", 30_000);
    advance(30_000);
    expect(lease.heartbeat("panel-a", 30_000)).toEqual({
      state: "parked",
      holder: "panel-a",
    });
  });

  it("only the holder can resume — from held and from parked", () => {
    const { lease, advance } = atClock();
    lease.acquire("panel-a", 30_000);
    expect(lease.resume("panel-b")).toMatchObject({ state: "held" });
    expect(lease.resume("panel-a")).toEqual({ state: "free" });

    lease.acquire("panel-a", 30_000);
    advance(30_000);
    expect(lease.resume("panel-b")).toMatchObject({ state: "parked" });
    expect(lease.resume("panel-a")).toEqual({ state: "free" });
  });

  it("release is resume under its user-facing name", () => {
    const { lease } = atClock();
    lease.acquire("panel-a", 30_000);
    expect(lease.release("panel-a")).toEqual({ state: "free" });
    expect(lease.consumeResumedDirty()).toBe(true);
  });

  it("resume arms the loud-resume flag exactly once", () => {
    const { lease } = atClock();
    expect(lease.consumeResumedDirty()).toBe(false);
    lease.acquire("panel-a", 30_000);
    expect(lease.consumeResumedDirty()).toBe(false);
    lease.resume("panel-a");
    expect(lease.consumeResumedDirty()).toBe(true);
    expect(lease.consumeResumedDirty()).toBe(false);
  });

  it("a refused resume does not arm the loud-resume flag", () => {
    const { lease } = atClock();
    lease.acquire("panel-a", 30_000);
    lease.resume("panel-b");
    expect(lease.consumeResumedDirty()).toBe(false);
  });

  it("resuming a free lease is a no-op", () => {
    const { lease } = atClock();
    expect(lease.resume("panel-a")).toEqual({ state: "free" });
    expect(lease.consumeResumedDirty()).toBe(false);
  });

  it("names auth and cookies in the resume note", () => {
    // The common handoff is a login, so a vague 'state may have changed'
    // would understate exactly the change that just happened.
    expect(RESUMED_AFTER_HANDOFF_NOTE).toMatch(/logins/i);
    expect(RESUMED_AFTER_HANDOFF_NOTE).toMatch(/cookies/i);
    expect(RESUMED_AFTER_HANDOFF_NOTE).toMatch(/do not rely on anything/i);
  });
});
