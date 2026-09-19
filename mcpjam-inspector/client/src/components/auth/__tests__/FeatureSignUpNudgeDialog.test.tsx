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
import { GATED_FEATURE_COPY } from "@/components/guest-preview/feature-highlights";
import { FeatureSignUpNudgeDialog } from "../FeatureSignUpNudgeDialog";

describe("FeatureSignUpNudgeDialog", () => {
  beforeEach(() => {
    signInMock.mockReset();
    signUpMock.mockReset();
    vi.mocked(track).mockReset();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/swarms");
  });

  it("shows the feature's own nudge copy", () => {
    const copy = GATED_FEATURE_COPY.swarms.nudge;
    render(
      <FeatureSignUpNudgeDialog feature="swarms" isOpen onClose={vi.fn()} />,
    );

    expect(screen.getByText(copy.title)).toBeInTheDocument();
    expect(screen.getByText(copy.body)).toBeInTheDocument();
    expect(copy.title).toBe("Create an account to run your first swarm");
    expect(copy.body).toBe(
      "Test your MCP server with agent personas pursuing different user goals. See where they succeed, where they get stuck, and what to improve.",
    );
    expect(
      screen.getByRole("button", { name: "Create free account" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  it("shows the jam artwork for both features", () => {
    const { rerender } = render(
      <FeatureSignUpNudgeDialog feature="swarms" isOpen onClose={vi.fn()} />,
    );
    expect(
      document.querySelector('img[src="/guest-credit-wall.png"]'),
    ).toBeInTheDocument();

    rerender(
      <FeatureSignUpNudgeDialog
        feature="user-testing"
        isOpen
        onClose={vi.fn()}
      />,
    );
    expect(
      document.querySelector('img[src="/guest-credit-wall.png"]'),
    ).toBeInTheDocument();
  });

  // The bullets are gone, and this is what stops them coming back by habit.
  // They carried sell lines nobody had signed off, including a "no card
  // needed" pricing promise, on a product bounded by credits.
  it("makes no claim about price", () => {
    render(
      <FeatureSignUpNudgeDialog feature="swarms" isOpen onClose={vi.fn()} />,
    );

    expect(screen.queryByText(/no card|free to start|on us/i)).toBeNull();
  });

  it("tracks one impression per opening, not per render", () => {
    const { rerender } = render(
      <FeatureSignUpNudgeDialog feature="swarms" isOpen onClose={vi.fn()} />,
    );
    rerender(
      <FeatureSignUpNudgeDialog feature="swarms" isOpen onClose={vi.fn()} />,
    );

    expect(
      vi
        .mocked(track)
        .mock.calls.filter(([event]) => event === "guest_feature_nudge_shown"),
    ).toHaveLength(1);
  });

  // Closing and reopening is a second, real impression — the ref resets on the
  // closed transition rather than living for the component's whole lifetime.
  it("counts a reopen as a new impression", () => {
    const { rerender } = render(
      <FeatureSignUpNudgeDialog feature="swarms" isOpen onClose={vi.fn()} />,
    );
    rerender(
      <FeatureSignUpNudgeDialog
        feature="swarms"
        isOpen={false}
        onClose={vi.fn()}
      />,
    );
    rerender(
      <FeatureSignUpNudgeDialog feature="swarms" isOpen onClose={vi.fn()} />,
    );

    expect(
      vi
        .mocked(track)
        .mock.calls.filter(([event]) => event === "guest_feature_nudge_shown"),
    ).toHaveLength(2);
  });

  it("Create free account remembers the tab, then starts WorkOS sign-up", () => {
    render(
      <FeatureSignUpNudgeDialog feature="swarms" isOpen onClose={vi.fn()} />,
    );

    screen.getByRole("button", { name: "Create free account" }).click();

    expect(signUpMock).toHaveBeenCalledTimes(1);
    expect(readAppSignInReturnPath()).toBe("/swarms/new");
    expect(track).toHaveBeenCalledWith(
      "sign_up_button_clicked",
      expect.objectContaining({ location: "swarms_guest_preview" }),
    );
  });

  it("the existing-account path returns to the swarm creation flow", () => {
    render(
      <FeatureSignUpNudgeDialog feature="swarms" isOpen onClose={vi.fn()} />,
    );

    screen.getByRole("button", { name: "Sign in" }).click();

    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(readAppSignInReturnPath()).toBe("/swarms/new");
    expect(track).toHaveBeenCalledWith(
      "login_button_clicked",
      expect.objectContaining({ location: "swarms_guest_preview" }),
    );
  });

  it("dismissing reports the dismissal and calls onClose", () => {
    const onClose = vi.fn();
    render(
      <FeatureSignUpNudgeDialog feature="swarms" isOpen onClose={onClose} />,
    );

    // Radix renders a labelled close control inside the dialog.
    screen.getByRole("button", { name: /close/i }).click();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(
      "guest_feature_nudge_dismissed",
      expect.objectContaining({ location: "swarms_guest_preview" }),
    );
  });

  it("carries User Testing's own copy and location", () => {
    window.history.replaceState({}, "", "/user-testing");
    render(
      <FeatureSignUpNudgeDialog
        feature="user-testing"
        isOpen
        onClose={vi.fn()}
      />,
    );

    const copy = GATED_FEATURE_COPY["user-testing"].nudge;
    expect(copy.title).toBe("Create an account to run your first study");
    expect(copy.body).toBe(
      "See how real users interact with your MCP server. Find out where they succeed, where they get stuck, and what to improve.",
    );
    expect(screen.getByText(copy.title)).toBeInTheDocument();
    expect(screen.getByText(copy.body)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();

    screen.getByRole("button", { name: "Create free account" }).click();

    expect(readAppSignInReturnPath()).toBe("/user-testing/new");
    expect(track).toHaveBeenCalledWith(
      "sign_up_button_clicked",
      expect.objectContaining({ location: "user_testing_guest_preview" }),
    );
  });
});
