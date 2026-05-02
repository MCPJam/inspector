import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GuestLimitDialog } from "../guest-limit-dialog";
import { useGuestLimitDialogStore } from "@/stores/guest-limit-dialog-store";

const signIn = vi.fn();
const authState: { isLoading: boolean; user: { id: string } | null } = {
  isLoading: false,
  user: null,
};

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    isLoading: authState.isLoading,
    user: authState.user,
    signIn,
  }),
}));

beforeEach(() => {
  signIn.mockReset();
  authState.isLoading = false;
  authState.user = null;
  useGuestLimitDialogStore.setState({
    authStatus: "loading",
    hasPendingLimit: false,
    isOpen: false,
  });
});

describe("GuestLimitDialog", () => {
  it("renders nothing while closed", () => {
    const { container } = render(<GuestLimitDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the dialog with guest copy when the store opens", () => {
    useGuestLimitDialogStore.setState({ isOpen: true });
    render(<GuestLimitDialog />);

    expect(
      screen.getByRole("heading", {
        name: /you've used today's free guest limit/i,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/6× more/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^sign in$/i }),
    ).toBeInTheDocument();
  });

  it("calls signIn() when the Sign in button is clicked", async () => {
    const user = userEvent.setup();
    useGuestLimitDialogStore.setState({ isOpen: true });
    render(<GuestLimitDialog />);

    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("closes the store when the dialog is dismissed", async () => {
    const user = userEvent.setup();
    useGuestLimitDialogStore.setState({ isOpen: true });
    render(<GuestLimitDialog />);

    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(useGuestLimitDialogStore.getState().isOpen).toBe(false);
  });

  it("never renders for signed-in users, even if the store is open", () => {
    authState.user = { id: "user-1" };
    useGuestLimitDialogStore.setState({ isOpen: true });

    const { container } = render(<GuestLimitDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it("does not render while auth state is loading", () => {
    authState.isLoading = true;
    useGuestLimitDialogStore.setState({ isOpen: true });

    const { container } = render(<GuestLimitDialog />);
    expect(container).toBeEmptyDOMElement();
  });
});
