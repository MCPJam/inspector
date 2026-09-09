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
import { readAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { GuestSignInMessage } from "../GuestSignInMessage";

describe("GuestSignInMessage", () => {
  beforeEach(() => {
    signInMock.mockReset();
    vi.mocked(track).mockReset();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
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

  it("remembers the whole current URL before handing off to WorkOS", () => {
    // WorkOS navigates away, so the capture has to happen on this click, not
    // in an effect afterwards. Project segment, query and hash all come back:
    // signing in from a project link must return to that link, not to the
    // app's front door with a project resolved from storage.
    const path = "/p/k5700000000000000000000000a/evals/suite/s1?view=runs#case";
    window.history.replaceState({}, "", path);

    render(<GuestSignInMessage />);
    screen.getByRole("button", { name: /Sign in/i }).click();

    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(readAppSignInReturnPath()).toBe(path);
  });
});
