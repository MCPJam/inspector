import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const signInMock = vi.fn();
const signUpMock = vi.fn();

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ signIn: signInMock, signUp: signUpMock }),
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { GuestPreviewCta } from "../GuestPreviewCta";

describe("GuestPreviewCta", () => {
  beforeEach(() => {
    signInMock.mockReset();
    signUpMock.mockReset();
  });

  it("opens the Swarms nudge from its create CTA", async () => {
    render(<GuestPreviewCta feature="swarms" />);

    expect(
      screen.getByRole("button", { name: "Create new swarm" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sign in" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create account" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create new swarm" }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", {
          name: "Create an account to run your first swarm",
        }),
      ).toBeInTheDocument(),
    );
  });

  it("opens the User Testing nudge from its create CTA", async () => {
    render(<GuestPreviewCta feature="user-testing" />);

    expect(
      screen.getByRole("button", { name: "Create new study" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sign in" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create account" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create new study" }));

    await waitFor(() =>
      expect(
        screen.getByRole("heading", {
          name: "Create an account to run your first study",
        }),
      ).toBeInTheDocument(),
    );
  });
});
