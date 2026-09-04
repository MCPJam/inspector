import { beforeEach, describe, expect, it } from "vitest";
import {
  isSignOutInProgress,
  markSignOutInProgress,
  resetSignOutLatchForTests,
  SIGN_OUT_SUPPRESSION_WINDOW_MS,
} from "../sign-out-latch";

describe("sign-out latch", () => {
  beforeEach(() => {
    resetSignOutLatchForTests();
  });

  it("is off until a sign-out starts", () => {
    expect(isSignOutInProgress()).toBe(false);
  });

  it("suppresses for the whole window a real sign-out needs", () => {
    const start = 1_000_000;
    markSignOutInProgress(start);

    // The refresh timer ticks every second, so the very next tick and every
    // one up to the navigation completing must be covered.
    expect(isSignOutInProgress(start)).toBe(true);
    expect(isSignOutInProgress(start + 1_000)).toBe(true);
    expect(isSignOutInProgress(start + SIGN_OUT_SUPPRESSION_WINDOW_MS)).toBe(
      true,
    );
  });

  it("expires, so a sign-out that never navigates cannot blind the tab", () => {
    // authkit's `signOut()` returns early without navigating when the access
    // token is already gone — pressing Log out on an ALREADY-dead session.
    // A permanent latch would leave this tab swallowing every genuine session
    // failure from then on, which is worse than the redirect being fixed.
    const start = 1_000_000;
    markSignOutInProgress(start);

    expect(
      isSignOutInProgress(start + SIGN_OUT_SUPPRESSION_WINDOW_MS + 1),
    ).toBe(false);
  });

  it("stops suppressing when the clock moves backwards", () => {
    // A backwards jump would otherwise read as "elapsed is negative", i.e.
    // still inside the window, and hold the latch open indefinitely.
    const start = 1_000_000;
    markSignOutInProgress(start);

    expect(isSignOutInProgress(start - 60_000)).toBe(false);
  });

  it("re-arms on a second sign-out attempt", () => {
    const start = 1_000_000;
    markSignOutInProgress(start);
    const afterExpiry = start + SIGN_OUT_SUPPRESSION_WINDOW_MS + 1;
    expect(isSignOutInProgress(afterExpiry)).toBe(false);

    markSignOutInProgress(afterExpiry);

    expect(isSignOutInProgress(afterExpiry)).toBe(true);
  });
});
