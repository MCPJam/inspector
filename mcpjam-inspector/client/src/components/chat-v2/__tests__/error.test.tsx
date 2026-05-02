import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBox } from "../error";
import { useGuestLimitDialogStore } from "@/stores/guest-limit-dialog-store";

const authState: { isLoading: boolean; user: { id: string } | null } = {
  isLoading: false,
  user: null,
};

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    isLoading: authState.isLoading,
    user: authState.user,
  }),
}));

beforeEach(() => {
  authState.isLoading = false;
  authState.user = null;
  useGuestLimitDialogStore.setState({
    authStatus: "loading",
    hasPendingLimit: false,
    isOpen: false,
  });
});

describe("ErrorBox guest daily-limit handling", () => {
  const guestLimitProps = {
    message:
      "Add your own API key in Settings > LLM Providers to keep chatting now, or try again tomorrow.",
    code: "mcpjam_rate_limit",
    onResetChat: vi.fn(),
  };

  it("renders nothing for guest limit errors after the request layer opens the modal", () => {
    const { container } = render(<ErrorBox {...guestLimitProps} />);

    expect(container).toBeEmptyDOMElement();
    expect(useGuestLimitDialogStore.getState().isOpen).toBe(false);
    expect(
      screen.queryByText(/Daily MCPJam model limit reached/i),
    ).not.toBeInTheDocument();
  });

  it("renders the existing inline banner for signed-in users hitting the same limit", () => {
    authState.user = { id: "user-1" };
    render(<ErrorBox {...guestLimitProps} />);

    expect(
      screen.getByText(/Daily MCPJam model limit reached/i),
    ).toBeInTheDocument();
    expect(useGuestLimitDialogStore.getState().isOpen).toBe(false);
  });

  it("does not treat auth-loading users as guests", () => {
    authState.isLoading = true;
    render(<ErrorBox {...guestLimitProps} />);

    expect(
      screen.getByText(/Daily MCPJam model limit reached/i),
    ).toBeInTheDocument();
    expect(useGuestLimitDialogStore.getState().isOpen).toBe(false);
  });

  it("renders the inline banner unchanged for non-rate-limit errors (guest)", () => {
    render(
      <ErrorBox
        message="Something exploded"
        code="provider_error"
        onResetChat={vi.fn()}
      />,
    );

    expect(screen.getByText(/Something exploded/i)).toBeInTheDocument();
    expect(useGuestLimitDialogStore.getState().isOpen).toBe(false);
  });
});
