import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRefreshBanner } from "../session-refresh-banner";
import { useSessionRefreshStore } from "@/stores/session-refresh-store";

const mockState = vi.hoisted(() => ({
  signIn: vi.fn(),
  captureAppSignInReturnPath: vi.fn(),
}));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ signIn: mockState.signIn }),
}));

vi.mock("@/lib/app-signin-return-path", () => ({
  captureAppSignInReturnPath: mockState.captureAppSignInReturnPath,
}));

vi.mock("@/lib/permalink-signin-return", () => ({
  permalinkSignInOptions: () => ({}),
}));

describe("SessionRefreshBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionRefreshStore.setState({
      status: "idle",
      kind: null,
      retryNonce: 0,
    });
  });

  it("renders nothing while auth is healthy", () => {
    render(<SessionRefreshBanner />);

    expect(screen.queryByTestId("session-refresh-banner")).toBeNull();
  });

  it("offers an in-place retry after a transient failure", () => {
    useSessionRefreshStore.setState({ status: "failed", kind: "transient" });
    render(<SessionRefreshBanner />);

    expect(screen.getByText("Couldn't refresh your session.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    // The nonce bump is what re-runs Convex's setAuth.
    expect(useSessionRefreshStore.getState().retryNonce).toBe(1);
    expect(useSessionRefreshStore.getState().status).toBe("retrying");
  });

  it("disables the button while a retry is in flight", () => {
    useSessionRefreshStore.setState({ status: "retrying", kind: "transient" });
    render(<SessionRefreshBanner />);

    const button = screen.getByRole("button", { name: /Retrying/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers sign-in when the session is genuinely dead", () => {
    useSessionRefreshStore.setState({ status: "failed", kind: "signed_out" });
    render(<SessionRefreshBanner />);

    expect(screen.getByText("Your session has expired.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(mockState.signIn).toHaveBeenCalledTimes(1);
    expect(mockState.captureAppSignInReturnPath).toHaveBeenCalledTimes(1);
  });

  it("can be dismissed", () => {
    useSessionRefreshStore.setState({ status: "failed", kind: "transient" });
    render(<SessionRefreshBanner />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(useSessionRefreshStore.getState().status).toBe("idle");
  });

  it("does not reject when signIn fails to navigate", () => {
    mockState.signIn.mockRejectedValue(new Error("navigation blocked"));
    useSessionRefreshStore.setState({ status: "failed", kind: "signed_out" });
    render(<SessionRefreshBanner />);

    expect(() =>
      fireEvent.click(screen.getByRole("button", { name: "Sign in" })),
    ).not.toThrow();
  });
});
