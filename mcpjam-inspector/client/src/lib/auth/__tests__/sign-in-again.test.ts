import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ captured: 0 }));

vi.mock("@/lib/app-signin-return-path", () => ({
  captureAppSignInReturnPath: () => {
    state.captured += 1;
  },
}));
vi.mock("@/lib/permalink-signin-return", () => ({
  permalinkSignInOptions: () => ({ state: { returnTo: "here" } }),
}));

import { signInAgain } from "../sign-in-again";
import { SIGN_OUT_REQUEST_TIMEOUT_MS } from "../sign-out-latch";

class NoSessionError extends Error {}

describe("signInAgain", () => {
  beforeEach(() => {
    state.captured = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens sign-in when there is no session left to end", async () => {
    const signOut = vi.fn(() => Promise.reject(new NoSessionError()));
    const signIn = vi.fn();
    await signInAgain({ signOut, signIn });
    expect(signOut).toHaveBeenCalledWith({ navigate: false });
    expect(state.captured).toBe(1);
    expect(signIn).toHaveBeenCalledWith({ state: { returnTo: "here" } });
  });

  it("ends a session that is still held before signing in", async () => {
    const order: string[] = [];
    const signOut = vi.fn(async () => {
      order.push("signOut");
    });
    const signIn = vi.fn(() => {
      order.push("signIn");
    });
    await signInAgain({ signOut, signIn });
    expect(order).toEqual(["signOut", "signIn"]);
  });

  it("still opens sign-in when the logout call never answers", async () => {
    vi.useFakeTimers();
    const signIn = vi.fn();
    const pending = signInAgain({
      signOut: () => new Promise<void>(() => {}),
      signIn,
    });
    await vi.advanceTimersByTimeAsync(SIGN_OUT_REQUEST_TIMEOUT_MS);
    await pending;
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("leaves saved servers and workspaces in local storage", async () => {
    // Recovery must not cost the user their local setup.
    localStorage.setItem("mcp-inspector-state", "servers");
    localStorage.setItem("mcp-inspector-projects", "workspaces");
    await signInAgain({ signOut: vi.fn(async () => {}), signIn: vi.fn() });
    expect(localStorage.getItem("mcp-inspector-state")).toBe("servers");
    expect(localStorage.getItem("mcp-inspector-projects")).toBe("workspaces");
  });
});
