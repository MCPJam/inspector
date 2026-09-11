import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const signInMock = vi.fn();
const signUpMock = vi.fn();

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ signIn: signInMock, signUp: signUpMock }),
}));

// Analytics goes through lib/analytics.ts#track (the ratchet forbids raw
// posthog.capture in components); mock it to assert the surface tag.
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { track } from "@/lib/analytics";
import { readAppSignInReturnPath } from "@/lib/app-signin-return-path";
import { consumePendingInviteDialog } from "@/lib/pending-invite-dialog";
import { InviteTeamSignUpDialog } from "../InviteTeamSignUpDialog";

describe("InviteTeamSignUpDialog", () => {
  beforeEach(() => {
    signInMock.mockReset();
    signUpMock.mockReset();
    vi.mocked(track).mockReset();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/servers");
  });

  it("tracks one impression per opening, not per render", () => {
    const { rerender } = render(
      <InviteTeamSignUpDialog isOpen onClose={vi.fn()} />,
    );
    rerender(<InviteTeamSignUpDialog isOpen onClose={vi.fn()} />);

    expect(
      vi
        .mocked(track)
        .mock.calls.filter(([event]) => event === "invite_signup_nudge_shown"),
    ).toHaveLength(1);
  });

  it("Create free account marks the pending invite, remembers the page, and starts WorkOS sign-up", () => {
    render(<InviteTeamSignUpDialog isOpen onClose={vi.fn()} />);

    screen.getByRole("button", { name: "Create free account" }).click();

    expect(signUpMock).toHaveBeenCalledTimes(1);
    // The marker the sidebar consumes post-reload to reopen the real invite
    // dialog — the whole point of the nudge.
    expect(consumePendingInviteDialog()).toBe(true);
    // Return-path capture happens on the click, before WorkOS navigates away.
    expect(readAppSignInReturnPath()).toBe("/servers");
    expect(track).toHaveBeenCalledWith(
      "sign_up_button_clicked",
      expect.objectContaining({ location: "invite_signup_nudge" }),
    );
  });

  it("Sign in marks the same pending invite — an existing account returns to the dialog too", () => {
    render(<InviteTeamSignUpDialog isOpen onClose={vi.fn()} />);

    screen.getByRole("button", { name: "Sign in" }).click();

    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(consumePendingInviteDialog()).toBe(true);
    expect(track).toHaveBeenCalledWith(
      "login_button_clicked",
      expect.objectContaining({ location: "invite_signup_nudge" }),
    );
  });

  it("dismissing reports the dismissal and calls onClose", () => {
    const onClose = vi.fn();
    render(<InviteTeamSignUpDialog isOpen onClose={onClose} />);

    // Radix renders a labelled close control inside the dialog.
    screen.getByRole("button", { name: /close/i }).click();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(
      "invite_signup_nudge_dismissed",
      expect.objectContaining({ location: "invite_signup_nudge" }),
    );
  });
});
