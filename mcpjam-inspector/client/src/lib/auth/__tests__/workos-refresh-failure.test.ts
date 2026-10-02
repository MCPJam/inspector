import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleWorkosRefreshFailure,
  markWorkosSessionSeen,
  resetWorkosSessionSeenForTests,
} from "../workos-refresh-failure";
import {
  markSignOutInProgress,
  resetSignOutLatchForTests,
  SIGN_OUT_SUPPRESSION_WINDOW_MS,
} from "../sign-out-latch";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";

const mockState = vi.hoisted(() => ({
  reportCaught: vi.fn(),
  track: vi.fn(),
  captureAppSignInReturnPath: vi.fn(),
  permalinkSignInOptions: vi.fn(() => ({ state: { permalink: "nonce-1" } })),
}));

vi.mock("@/lib/error-reporting", () => ({
  reportCaught: mockState.reportCaught,
}));

vi.mock("@/lib/analytics", () => ({
  track: mockState.track,
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
    resetWorkosSessionSeenForTests();
    // Most cases model a tab that held a session; the guest case resets this.
    markWorkosSessionSeen();
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

  it("tracks the expiry as an event, not an error, and sends the user to sign in", () => {
    // An expired session is expected (WorkOS's max session length), so it
    // must not land in error tracking.
    const signIn = vi.fn();

    handleWorkosRefreshFailure({ signIn });

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(mockState.track).toHaveBeenCalledTimes(1);
    expect(mockState.track).toHaveBeenCalledWith(
      "workos_session_expired",
      expect.any(Object),
    );
    expect(mockState.reportCaught).not.toHaveBeenCalled();
  });

  it("leaves a tab that never signed in as a guest and reports it", () => {
    // authkit fires this for a signed-out visitor whose first refresh failed
    // on the network. There is no session to sign back into, so redirecting
    // would push a guest onto the login page.
    resetWorkosSessionSeenForTests();
    const signIn = vi.fn();

    handleWorkosRefreshFailure({ signIn });

    expect(signIn).not.toHaveBeenCalled();
    expect(mockState.captureAppSignInReturnPath).not.toHaveBeenCalled();
    expect(mockState.track).not.toHaveBeenCalled();
    expect(useSessionRefreshStore.getState().status).toBe("idle");
    expect(mockState.reportCaught).toHaveBeenCalledTimes(1);
    expect(mockState.reportCaught).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        source: "workos_refresh_failure_no_session",
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
    expect(mockState.track).not.toHaveBeenCalled();
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
