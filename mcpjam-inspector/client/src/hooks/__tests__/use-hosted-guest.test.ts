import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseAuth, hostedMode } = vi.hoisted(() => ({
  mockUseAuth: vi.fn(),
  hostedMode: { value: true },
}));

vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => mockUseAuth() }));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    get HOSTED_MODE() {
      return hostedMode.value;
    },
  };
});

import { useIsHostedGuest } from "../use-hosted-guest";

describe("useIsHostedGuest", () => {
  beforeEach(() => {
    hostedMode.value = true;
    mockUseAuth.mockReturnValue({ user: null, isLoading: false });
  });

  it("is true for a hosted visitor with no WorkOS account", () => {
    const { result } = renderHook(() => useIsHostedGuest());
    expect(result.current).toBe(true);
  });

  it("is false once WorkOS hands over a user", () => {
    mockUseAuth.mockReturnValue({
      user: { email: "someone@example.com" },
      isLoading: false,
    });
    const { result } = renderHook(() => useIsHostedGuest());
    expect(result.current).toBe(false);
  });

  // The window this exists to protect: `user` is null during hydrate for
  // signed-in people too, so answering early flashes a sign-up wall at paying
  // customers on every cold load.
  it("is undefined while WorkOS is still resolving", () => {
    mockUseAuth.mockReturnValue({ user: null, isLoading: true });
    const { result } = renderHook(() => useIsHostedGuest());
    expect(result.current).toBeUndefined();
  });

  // A background token refresh must not re-open the "don't know yet" window on
  // someone already signed in — that would blank the tab mid-session.
  it("stays false when a user is present and loading flips back on", () => {
    mockUseAuth.mockReturnValue({
      user: { email: "someone@example.com" },
      isLoading: true,
    });
    const { result } = renderHook(() => useIsHostedGuest());
    expect(result.current).toBe(false);
  });

  // A local install has no WorkOS to sign up through, so there is nothing to
  // gate and nowhere to send them.
  it("is false on a local install, even with no user and mid-load", () => {
    hostedMode.value = false;
    mockUseAuth.mockReturnValue({ user: null, isLoading: true });
    const { result } = renderHook(() => useIsHostedGuest());
    expect(result.current).toBe(false);
  });
});
