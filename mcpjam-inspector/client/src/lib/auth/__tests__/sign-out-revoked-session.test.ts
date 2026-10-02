import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSignOutInProgress,
  markSignOutInProgress,
  resetSignOutLatchForTests,
  SIGN_OUT_REQUEST_TIMEOUT_MS,
  SIGN_OUT_SUPPRESSION_WINDOW_MS,
} from "../sign-out-latch";
import {
  REPEAT_SIGN_OUT_GUARD_MS,
  SESSION_ENDED_MESSAGE,
  SESSION_ENDED_NOTICE_MS,
  signOutRevokedSession,
} from "../sign-out-revoked-session";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";
import { useSignOutStore } from "@/stores/sign-out-store";

const NOW = 1_800_000_000_000;

describe("signOutRevokedSession", () => {
  const assign = vi.fn();
  const realLocation = window.location;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    resetSignOutLatchForTests();
    window.sessionStorage.clear();
    useSignOutStore.setState({ isSigningOut: false, message: undefined });
    useSessionRefreshStore.getState().clear();
    assign.mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...realLocation, origin: "https://app.example.test", assign },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  });

  it("latches, shows the notice, ends the AuthKit session, then returns to the front door", async () => {
    const signOut = vi.fn().mockResolvedValue(undefined);

    const done = signOutRevokedSession(signOut);

    expect(isSignOutInProgress()).toBe(true);
    expect(useSignOutStore.getState()).toMatchObject({
      isSigningOut: true,
      message: SESSION_ENDED_MESSAGE,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(signOut).toHaveBeenCalledWith({
      returnTo: "https://app.example.test",
      navigate: false,
    });

    // The notice stays up long enough to read, even when logout is instant.
    await vi.advanceTimersByTimeAsync(SESSION_ENDED_NOTICE_MS - 1);
    expect(assign).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(assign).toHaveBeenCalledExactlyOnceWith("https://app.example.test");
  });

  it("navigates anyway when the logout request hangs, inside the latch window", async () => {
    const signOut = vi.fn(() => new Promise<void>(() => {}));

    const done = signOutRevokedSession(signOut);
    await vi.advanceTimersByTimeAsync(SIGN_OUT_REQUEST_TIMEOUT_MS);
    await done;

    expect(assign).toHaveBeenCalledOnce();
    expect(
      Math.max(SIGN_OUT_REQUEST_TIMEOUT_MS, SESSION_ENDED_NOTICE_MS),
    ).toBeLessThan(SIGN_OUT_SUPPRESSION_WINDOW_MS);
  });

  it("navigates anyway when signOut throws", async () => {
    const signOut = vi.fn(() => {
      throw new Error("no token");
    });

    const done = signOutRevokedSession(signOut);
    await vi.advanceTimersByTimeAsync(SESSION_ENDED_NOTICE_MS);
    await done;

    expect(assign).toHaveBeenCalledOnce();
  });

  it("does not sign out a second time right after the first, and shows the signed-out banner", async () => {
    const first = signOutRevokedSession(vi.fn().mockResolvedValue(undefined));
    await vi.advanceTimersByTimeAsync(SESSION_ENDED_NOTICE_MS);
    await first;

    // The page reloaded and the same session came back.
    resetSignOutLatchForTests();
    useSignOutStore.setState({ isSigningOut: false, message: undefined });
    assign.mockReset();
    const signOut = vi.fn();

    await signOutRevokedSession(signOut, NOW + REPEAT_SIGN_OUT_GUARD_MS - 1);

    expect(signOut).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(useSignOutStore.getState().isSigningOut).toBe(false);
    expect(useSessionRefreshStore.getState()).toMatchObject({
      status: "failed",
      kind: "signed_out",
    });
  });

  it("signs out again once the guard has passed", async () => {
    window.sessionStorage.setItem(
      "mcpjam.sessionRevokedSignOutAt",
      String(NOW - REPEAT_SIGN_OUT_GUARD_MS),
    );
    const signOut = vi.fn().mockResolvedValue(undefined);

    const done = signOutRevokedSession(signOut);
    await vi.advanceTimersByTimeAsync(SESSION_ENDED_NOTICE_MS);
    await done;

    expect(signOut).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledOnce();
  });

  it("leaves a sign-out already under way to finish on its own", async () => {
    markSignOutInProgress();
    const signOut = vi.fn();

    await signOutRevokedSession(signOut);

    expect(signOut).not.toHaveBeenCalled();
    expect(useSignOutStore.getState().message).toBeUndefined();
    expect(assign).not.toHaveBeenCalled();
  });
});
