import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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

  it("offers a way out when sign-in fails instead of spinning forever", async () => {
    // A rejection means the browser is NOT leaving the page. Without this the
    // visitor sits on the spinner with nothing to click — and this route IS the
    // entry point an SSO user arrives on, so a dead end costs them the login.
    signInMock.mockRejectedValueOnce(new Error("authorize failed"));
    render(<LoginInitiationRoute />);

    await waitFor(() =>
      expect(screen.getByTestId("login-initiation-error")).toBeInTheDocument()
    );
    expect(screen.queryByTestId("login-initiation")).not.toBeInTheDocument();
    // Announced, not just rendered: the failure swaps in without a navigation,
    // so assistive tech has nothing else to notice it by.
    expect(screen.getByRole("alert")).toHaveTextContent(
      /Couldn't start sign-in/
    );

    // Retry re-initiates rather than reloading: the guard against a duplicate
    // automatic sign-in must not also block a deliberate one.
    fireEvent.click(screen.getByRole("button", { name: /Try again/i }));
    await waitFor(() => expect(signInMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("login-initiation")).toBeInTheDocument();
  });

  it("recovers from a signIn() that throws before returning a promise", async () => {
    // A synchronous throw is not a rejected promise; `.catch` alone misses it
    // and the failure state never renders.
    signInMock.mockImplementationOnce(() => {
      throw new Error("client not initialized");
    });
    render(<LoginInitiationRoute />);

    await waitFor(() =>
      expect(screen.getByTestId("login-initiation-error")).toBeInTheDocument()
    );
  });
});
