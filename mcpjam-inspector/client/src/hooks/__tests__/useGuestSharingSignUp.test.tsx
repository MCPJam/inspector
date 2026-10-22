import { act, render, renderHook } from "@testing-library/react";
import { ConvexError } from "convex/values";
import { describe, expect, it, vi } from "vitest";

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ signIn: vi.fn(), signUp: vi.fn() }),
}));

import { expectLegalConsentLinks } from "@/test/legal-consent";
import { useGuestSharingSignUp } from "../useGuestSharingSignUp";

describe("useGuestSharingSignUp", () => {
  it("handles the structured Convex code, independent of the backend copy", () => {
    const { result } = renderHook(() => useGuestSharingSignUp());
    act(() => {
      expect(
        result.current.handleGuestSharingError(
          new ConvexError({
            code: "guest_sharing_requires_sign_in",
            message: "Backend copy may change",
          }),
        ),
      ).toBe(true);
    });
    expect(result.current.guestSharingPrompt).not.toBeNull();
  });

  it("links the Terms of Use and Privacy Policy in the sign-up prompt", () => {
    const { result } = renderHook(() => useGuestSharingSignUp());
    act(() => {
      result.current.handleGuestSharingError(
        new ConvexError({ code: "guest_sharing_requires_sign_in" }),
      );
    });
    render(result.current.guestSharingPrompt);
    expectLegalConsentLinks();
  });

  it.each([
    null,
    undefined,
    "guest_sharing_requires_sign_in",
    new Error("guest_sharing_requires_sign_in"),
    {},
    { data: null },
    { data: "guest_sharing_requires_sign_in" },
    { data: { message: "Sign up to share" } },
    { data: { code: "FORBIDDEN" } },
  ])("leaves unrelated or malformed errors to the caller: %j", (error) => {
    const { result } = renderHook(() => useGuestSharingSignUp());
    expect(result.current.handleGuestSharingError(error)).toBe(false);
    expect(result.current.guestSharingPrompt).toBeNull();
  });
});
