import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleWorkosRefreshFailure } from "../workos-refresh-failure";
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
});
