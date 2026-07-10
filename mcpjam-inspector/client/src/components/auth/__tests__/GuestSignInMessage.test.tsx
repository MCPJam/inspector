import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const signInMock = vi.fn();
const captureMock = vi.fn();

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ signIn: signInMock }),
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: captureMock }),
}));

import { GuestSignInMessage } from "../GuestSignInMessage";

describe("GuestSignInMessage", () => {
  beforeEach(() => {
    signInMock.mockReset();
    captureMock.mockReset();
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
    expect(captureMock).toHaveBeenCalledWith(
      "login_button_clicked",
      expect.objectContaining({ location: "computer_view" })
    );
  });

  it("falls back to the default location tag when none is passed", () => {
    render(<GuestSignInMessage />);
    screen.getByRole("button", { name: /Sign in/i }).click();
    expect(captureMock).toHaveBeenCalledWith(
      "login_button_clicked",
      expect.objectContaining({ location: "guest_signin_message" })
    );
  });
});
