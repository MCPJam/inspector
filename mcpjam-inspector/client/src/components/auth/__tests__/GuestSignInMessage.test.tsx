import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const signInMock = vi.fn();

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ signIn: signInMock }),
}));

// Analytics goes through lib/analytics.ts#track (the ratchet forbids raw
// posthog.capture in components); mock it to assert the surface tag.
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { track } from "@/lib/analytics";
import { GuestSignInMessage } from "../GuestSignInMessage";

describe("GuestSignInMessage", () => {
  beforeEach(() => {
    signInMock.mockReset();
    vi.mocked(track).mockReset();
  });

  it("renders the honest one-liner and an actionable Sign in button", () => {
    render(<GuestSignInMessage message="Sign in to use the harness." />);
    expect(screen.getByText(/Sign in to use the harness\./)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Sign in/i })
    ).toBeInTheDocument();
  });

  it("triggers the WorkOS sign-in flow on click (not a silent/dead-end state)", () => {
    render(<GuestSignInMessage location="computer_view" />);
    screen.getByRole("button", { name: /Sign in/i }).click();
    expect(signInMock).toHaveBeenCalledTimes(1);
    // Analytics tag carries the surface so we can see where guests convert.
    expect(track).toHaveBeenCalledWith(
      "login_button_clicked",
      expect.objectContaining({ location: "computer_view" })
    );
  });

  it("falls back to the default location tag when none is passed", () => {
    render(<GuestSignInMessage />);
    screen.getByRole("button", { name: /Sign in/i }).click();
    expect(track).toHaveBeenCalledWith(
      "login_button_clicked",
      expect.objectContaining({ location: "guest_signin_message" })
    );
  });
});
