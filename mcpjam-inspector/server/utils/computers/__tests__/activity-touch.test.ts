/**
 * The throttle in front of a control-plane write.
 *
 * It decides how often "somebody is using this machine" reaches the idle
 * sweep, against traffic — a tool poll, a click, a keystroke — that arrives far
 * faster than the sweep's 30-minute window needs.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_TOUCH_THROTTLE_MS,
  MAX_TRACKED_COMPUTERS,
  resetActivityThrottleForTests,
  shouldTouchActivity,
  shouldTouchSessionCommand,
  trackedComputerCountForTests,
  trackedSessionCountForTests,
} from "../activity-touch";

beforeEach(() => resetActivityThrottleForTests());

describe("shouldTouchActivity", () => {
  it("lets the first touch through", () => {
    expect(shouldTouchActivity("comp-1", 1_000)).toBe(true);
  });

  it("lets the first touch through even at time zero", () => {
    // The absent-entry sentinel has to stay distinct from a recorded 0. Read
    // as "last touched at the epoch", a computer nobody has touched is
    // throttled out of its very first touch.
    expect(shouldTouchActivity("comp-1", 0)).toBe(true);
  });

  it("refuses a second touch inside the window", () => {
    expect(shouldTouchActivity("comp-1", 0)).toBe(true);
    expect(shouldTouchActivity("comp-1", ACTIVITY_TOUCH_THROTTLE_MS - 1)).toBe(
      false,
    );
  });

  it("lets one through again once the window has passed", () => {
    expect(shouldTouchActivity("comp-1", 0)).toBe(true);
    expect(shouldTouchActivity("comp-1", ACTIVITY_TOUCH_THROTTLE_MS)).toBe(
      true,
    );
  });

  it("throttles each computer separately", () => {
    // One busy machine must not suppress another's activity, or a second
    // computer hibernates while someone is working on it.
    expect(shouldTouchActivity("comp-1", 0)).toBe(true);
    expect(shouldTouchActivity("comp-2", 0)).toBe(true);
  });

  it("recovers when the clock steps backwards", () => {
    // An NTP correction, or a suspended VM waking, leaves a stamp in the
    // future. Compared as a signed gap that suppresses every touch until real
    // time catches up — indefinitely — and somebody's browser hibernates
    // underneath them while they are using it.
    expect(shouldTouchActivity("comp-1", 10 * ACTIVITY_TOUCH_THROTTLE_MS)).toBe(
      true,
    );
    expect(shouldTouchActivity("comp-1", 0)).toBe(true);
  });

  it("does not grow without bound", () => {
    // One entry per computer, for the life of the process. Small each, and the
    // kind of leak that is found in a heap dump a year later.
    for (let i = 0; i < MAX_TRACKED_COMPUTERS + 500; i += 1) {
      shouldTouchActivity(`comp-${i}`, i);
    }
    expect(trackedComputerCountForTests()).toBeLessThanOrEqual(
      MAX_TRACKED_COMPUTERS,
    );
    // And the eviction is harmless: the newest computer is still throttled.
    const newest = `comp-${MAX_TRACKED_COMPUTERS + 499}`;
    expect(shouldTouchActivity(newest, MAX_TRACKED_COMPUTERS + 499)).toBe(
      false,
    );
  });

  it("records only when it answers yes", () => {
    // Asked-and-refused must not reset the clock, or a caller polling faster
    // than the window would push the next allowed touch out forever.
    expect(shouldTouchActivity("comp-1", 0)).toBe(true);
    for (let t = 1; t < ACTIVITY_TOUCH_THROTTLE_MS; t += 1_000) {
      shouldTouchActivity("comp-1", t);
    }
    expect(shouldTouchActivity("comp-1", ACTIVITY_TOUCH_THROTTLE_MS)).toBe(
      true,
    );
  });
});

describe("shouldTouchSessionCommand", () => {
  it("throttles a per-input storm down to one write a minute", () => {
    // THE REGRESSION: the once-a-minute gate came to guard only the computer
    // touch, leaving `touchSession({kind:'command'})` firing on every landed
    // input flush. A mouse drag is 10-20 of those a second per viewer, and each
    // one is a control-plane write.
    expect(shouldTouchSessionCommand("sess-1", 0)).toBe(true);
    for (let i = 1; i < 40; i++) {
      expect(shouldTouchSessionCommand("sess-1", i * 50)).toBe(false);
    }
    expect(
      shouldTouchSessionCommand("sess-1", ACTIVITY_TOUCH_THROTTLE_MS),
    ).toBe(true);
  });

  it("is LEADING EDGE, so somebody coming back is never made to wait", () => {
    // The first input after an idle stretch has to write immediately — that is
    // the one that must not let a box be slept out from under a person.
    expect(shouldTouchSessionCommand("sess-idle", 0)).toBe(true);
    const longAfter = 10 * ACTIVITY_TOUCH_THROTTLE_MS;
    expect(shouldTouchSessionCommand("sess-idle", longAfter)).toBe(true);
  });

  it("keeps its own key space, so a session cannot evict a computer", () => {
    // Two clocks over ids from two different tables. Sharing one map would let
    // a busy key space push the other out of a single eviction budget.
    expect(shouldTouchActivity("comp-x", 0)).toBe(true);
    expect(shouldTouchSessionCommand("comp-x", 0)).toBe(true);
    expect(trackedComputerCountForTests()).toBe(1);
    expect(trackedSessionCountForTests()).toBe(1);
  });

  it("is cleared by the shared test reset", () => {
    shouldTouchSessionCommand("sess-reset", 0);
    expect(trackedSessionCountForTests()).toBe(1);
    resetActivityThrottleForTests();
    expect(trackedSessionCountForTests()).toBe(0);
  });

  it("evicts oldest-first, like the computer clock", () => {
    for (let i = 0; i < MAX_TRACKED_COMPUTERS + 10; i++) {
      shouldTouchSessionCommand(`sess-${i}`, i);
    }
    expect(trackedSessionCountForTests()).toBe(MAX_TRACKED_COMPUTERS);
  });
});
