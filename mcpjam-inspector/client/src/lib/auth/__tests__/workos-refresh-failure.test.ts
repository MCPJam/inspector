import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWorkosRefreshFailure } from "../workos-refresh-failure";
import {
  markSignOutInProgress,
  resetSignOutLatchForTests,
  SIGN_OUT_SUPPRESSION_WINDOW_MS,
} from "../sign-out-latch";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";

const mockState = vi.hoisted(() => ({
  reportCaught: vi.fn(),
  captureAppSignInReturnPath: vi.fn(),
  permalinkSignInOptions: vi.fn(() => ({ state: { permalink: "nonce-1" } })),
}));

vi.mock("@/lib/error-reporting", () => ({
  reportCaught: mockState.reportCaught,
}));

vi.mock("@/lib/app-signin-return-path", () => ({
  captureAppSignInReturnPath: mockState.captureAppSignInReturnPath,
}));

vi.mock("@/lib/permalink-signin-return", () => ({
  permalinkSignInOptions: mockState.permalinkSignInOptions,
}));

describe("handleWorkosRefreshFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSignOutLatchForTests();
    useSessionRefreshStore.setState({
      status: "idle",
      kind: null,
      retryNonce: 0,
    });
  });

  it("raises the signed-out banner before navigating away", () => {
    // If the redirect is blocked, this is the only thing standing between the
    // user and signed-in chrome over a dead session.
    handleWorkosRefreshFailure({ signIn: vi.fn() });

    expect(useSessionRefreshStore.getState().status).toBe("failed");
    expect(useSessionRefreshStore.getState().kind).toBe("signed_out");
  });

  it("preserves where the user was across the forced redirect", () => {
    // This redirect is involuntary, so losing the deep link and its project
    // scope would dump the user at the front door through no action of theirs.
    const signIn = vi.fn();

    handleWorkosRefreshFailure({ signIn });

    expect(mockState.captureAppSignInReturnPath).toHaveBeenCalledTimes(1);
    expect(signIn).toHaveBeenCalledWith({ state: { permalink: "nonce-1" } });
  });

  it("reports one warning and sends the user to sign in", () => {
    const signIn = vi.fn();

    handleWorkosRefreshFailure({ signIn });

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(mockState.reportCaught).toHaveBeenCalledTimes(1);
    expect(mockState.reportCaught).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        source: "workos_refresh_failure",
        level: "warning",
      }),
    );
  });

  it("does not reject when signIn returns a rejected promise", () => {
    // The redirect is fire-and-forget; a failure to navigate must not surface
    // as an unhandled rejection inside authkit's callback.
    const signIn = vi.fn().mockRejectedValue(new Error("navigation blocked"));

    expect(() => handleWorkosRefreshFailure({ signIn })).not.toThrow();
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("ignores the refresh failure a sign-out causes itself", () => {
    // Signing out revokes the session, and authkit's refresh timer keeps
    // ticking through the logout navigation — so it reports the revocation we
    // asked for. Redirecting on it would `location.assign` to the hosted login
    // page over the still-pending logout, which is what put the user on a sign
    // in screen when they pressed Log out.
    const signIn = vi.fn();
    markSignOutInProgress();

    handleWorkosRefreshFailure({ signIn });

    expect(signIn).not.toHaveBeenCalled();
    expect(mockState.captureAppSignInReturnPath).not.toHaveBeenCalled();
    expect(mockState.reportCaught).not.toHaveBeenCalled();
    expect(useSessionRefreshStore.getState().status).toBe("idle");
  });

  it("resumes redirecting once the sign-out window lapses", () => {
    // A sign-out on an already-dead session never navigates, so the tab lives
    // on. It must go back to handling real session failures.
    const signIn = vi.fn();
    markSignOutInProgress(Date.now() - SIGN_OUT_SUPPRESSION_WINDOW_MS - 1);

    handleWorkosRefreshFailure({ signIn });

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(useSessionRefreshStore.getState().kind).toBe("signed_out");
  });
});
