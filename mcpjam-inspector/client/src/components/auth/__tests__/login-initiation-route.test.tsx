import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const signInMock = vi.fn();
const navigateMock = vi.fn();
let authState: { user: unknown; isLoading: boolean } = {
  user: null,
  isLoading: false,
};

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ ...authState, signIn: signInMock }),
}));

vi.mock("@/lib/app-navigation", () => ({
  useAppNavigate: () => navigateMock,
}));

import { LoginInitiationRoute } from "../login-initiation-route";

describe("LoginInitiationRoute", () => {
  beforeEach(() => {
    signInMock.mockReset();
    navigateMock.mockReset();
    authState = { user: null, isLoading: false };
  });

  it("starts a fresh app-originated sign-in for a signed-out visitor", async () => {
    // This is the whole point of the route: authkit-js only writes the PKCE
    // verifier `/callback` needs when the sign-in starts here, in this tab.
    render(<LoginInitiationRoute />);
    await waitFor(() => expect(signInMock).toHaveBeenCalledTimes(1));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("waits for auth to settle before deciding", async () => {
    // Calling signIn() against a still-loading session would redirect a user
    // who already has one.
    authState = { user: null, isLoading: true };
    const { rerender } = render(<LoginInitiationRoute />);
    expect(signInMock).not.toHaveBeenCalled();

    authState = { user: { id: "user_1" }, isLoading: false };
    rerender(<LoginInitiationRoute />);
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/", { replace: true })
    );
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("sends an already-signed-in visitor into the app instead", async () => {
    // A second tile click arrives with a live session; there is nothing to
    // initiate, and re-running sign-in would bounce them through WorkOS again.
    authState = { user: { id: "user_1" }, isLoading: false };
    render(<LoginInitiationRoute />);
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/", { replace: true })
    );
    expect(signInMock).not.toHaveBeenCalled();
  });

  it("initiates sign-in exactly once across re-renders", async () => {
    // `signIn()` is a full-page navigation; two of them race two PKCE
    // verifiers against one another. StrictMode double-invokes effects.
    const { rerender } = render(<LoginInitiationRoute />);
    rerender(<LoginInitiationRoute />);
    rerender(<LoginInitiationRoute />);
    await waitFor(() => expect(signInMock).toHaveBeenCalledTimes(1));
  });

  it("renders a signing-in state rather than a blank screen", () => {
    render(<LoginInitiationRoute />);
    expect(screen.getByTestId("login-initiation")).toBeInTheDocument();
    expect(screen.getByText(/Signing you in/)).toBeInTheDocument();
  });
});
