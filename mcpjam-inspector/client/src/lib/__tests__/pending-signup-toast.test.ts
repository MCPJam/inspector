import { beforeEach, describe, expect, it } from "vitest";
import {
  consumePendingSignUpToast,
  markPendingSignUpToast,
  PENDING_SIGNUP_TOAST_TTL_MS,
} from "../pending-signup-toast";

describe("pending sign-up toast marker", () => {
  beforeEach(() => sessionStorage.clear());

  it("is consumed exactly once", () => {
    markPendingSignUpToast(1_000);
    expect(consumePendingSignUpToast(2_000)).toBe(1_000);
    expect(consumePendingSignUpToast(2_000)).toBeNull();
  });

  it("expires, and is cleared even when expired", () => {
    markPendingSignUpToast(0);
    expect(
      consumePendingSignUpToast(PENDING_SIGNUP_TOAST_TTL_MS + 1),
    ).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it("ignores a malformed value", () => {
    sessionStorage.setItem("mcpjam:pending-signup-toast-v1", "{nope");
    expect(consumePendingSignUpToast()).toBeNull();
  });
});
