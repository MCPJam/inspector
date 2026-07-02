import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBox } from "../error";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";

beforeEach(() => {
  useMCPJamLimitDialogStore.setState({
    authStatus: "loading",
    hasPendingLimit: false,
    outOfCreditsHit: false,
    outOfCreditsOrganizationId: null,
    isOpen: false,
    intent: null,
    organizationId: null,
    pendingInput: null,
  });
});

describe("ErrorBox daily-limit handling", () => {
  const guestLimitProps = {
    message:
      "Add your own API key in Settings > LLM Providers to keep chatting now, or try again tomorrow.",
    code: "mcpjam_rate_limit",
    onResetChat: vi.fn(),
  };

  it("renders nothing for guest limit errors after the request layer opens the modal", () => {
    const { container } = render(<ErrorBox {...guestLimitProps} />);

    expect(container).toBeEmptyDOMElement();
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
    expect(
      screen.queryByText(/Daily MCPJam model limit reached/i)
    ).not.toBeInTheDocument();
  });

  it("renders nothing for signed-in users hitting the same limit (modal takes over)", () => {
    const { container } = render(<ErrorBox {...guestLimitProps} />);

    expect(container).toBeEmptyDOMElement();
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });

  it("renders nothing for signed-in user_rate_limit (modal takes over)", () => {
    const { container } = render(
      <ErrorBox
        message="Daily MCPJam model limit reached."
        code="user_rate_limit"
        limitKind="total"
        onResetChat={vi.fn()}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("still renders the concurrency-throttle banner inline", () => {
    render(
      <ErrorBox
        message="Another credit-funded chat is finishing."
        code="user_rate_limit"
        limitKind="concurrency"
        retryAfterMs={3000}
        onResetChat={vi.fn()}
      />
    );

    expect(
      screen.getByText(/Another credit-funded chat is finishing/i)
    ).toBeInTheDocument();
  });

  it("renders the inline banner unchanged for non-rate-limit errors", () => {
    render(
      <ErrorBox
        message="Something exploded"
        code="provider_error"
        onResetChat={vi.fn()}
      />
    );

    expect(screen.getByText(/Something exploded/i)).toBeInTheDocument();
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });

  it("still renders the wallet-locked banner when walletLocked is set", () => {
    render(<ErrorBox message="Locked" walletLocked onResetChat={vi.fn()} />);

    expect(screen.getByText(/Account under review/i)).toBeInTheDocument();
  });
});
