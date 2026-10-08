import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => auth }));

import { SignOutBoundary } from "../SignOutBoundary";
import {
  notifySessionRevoked,
  resetSessionRevokedForTests,
} from "@/lib/auth/session-revoked";
import { resetSignOutLatchForTests } from "@/lib/auth/sign-out-latch";
import { SESSION_ENDED_MESSAGE } from "@/lib/auth/sign-out-revoked-session";
import { useSignOutStore } from "@/stores/sign-out-store";

describe("SignOutBoundary — revoked session", () => {
  const realLocation = window.location;
  const assign = vi.fn();

  beforeEach(() => {
    assign.mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...realLocation, origin: "https://app.example.test", assign },
    });
    resetSessionRevokedForTests();
    resetSignOutLatchForTests();
    window.sessionStorage.clear();
    useSignOutStore.setState({ isSigningOut: false, message: undefined });
    auth.signOut.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    resetSessionRevokedForTests();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  });

  it("signs the tab out once and says why", async () => {
    render(
      <SignOutBoundary>
        <p>app</p>
      </SignOutBoundary>,
    );
    expect(screen.getByText("app")).toBeTruthy();

    await act(async () => {
      notifySessionRevoked();
      notifySessionRevoked();
    });

    expect(screen.getByText(SESSION_ENDED_MESSAGE)).toBeTruthy();
    expect(screen.queryByText("app")).toBeNull();
    expect(auth.signOut).toHaveBeenCalledOnce();
    expect(auth.signOut).toHaveBeenCalledWith({
      returnTo: "https://app.example.test",
      navigate: false,
    });
    await vi.waitFor(() => expect(assign).toHaveBeenCalledOnce(), {
      timeout: 3_000,
    });
  });

  it("shows no message on an ordinary sign-out", () => {
    render(
      <SignOutBoundary>
        <p>app</p>
      </SignOutBoundary>,
    );

    act(() => useSignOutStore.setState({ isSigningOut: true }));

    expect(screen.queryByText("app")).toBeNull();
    expect(screen.queryByText(SESSION_ENDED_MESSAGE)).toBeNull();
  });
});
