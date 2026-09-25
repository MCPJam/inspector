import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ErrorBox } from "../error";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import { useModelPickerIntentStore } from "@/stores/model-picker-intent-store";

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

describe("ErrorBox provider_not_allowlisted", () => {
  const message =
    'The "openai" provider is not enabled on MCPJam\'s AI Gateway provider allowlist, so MCPJam cannot serve this model right now.';

  it("explains the hosted gateway refusal without a retry or an API-key fix", () => {
    const onRetry = vi.fn();
    render(
      <ErrorBox
        message={message}
        code="provider_not_allowlisted"
        statusCode={403}
        isRetryable={false}
        isMCPJamPlatformError
        onRetry={onRetry}
        onResetChat={vi.fn()}
      />
    );

    const banner = screen.getByTestId("chat-error-provider-not-allowlisted");
    expect(banner).toHaveTextContent("Model provider not enabled on MCPJam");
    expect(banner).toHaveTextContent('The "openai" provider is not enabled');
    expect(banner).toHaveTextContent(
      "Retrying or changing your API key won't help."
    );
    expect(banner).toHaveTextContent(
      "Choose a model from a different provider."
    );
    expect(banner).toHaveTextContent(/BYOK/);
    expect(banner).not.toHaveTextContent(/check your api key/i);
    expect(banner).not.toHaveTextContent(/temporary issue/i);
    expect(
      screen.queryByRole("button", { name: /retry/i })
    ).not.toBeInTheDocument();
  });

  it("opens the model picker's provider tab for the user's own key", () => {
    const release = useModelPickerIntentStore
      .getState()
      .registerProvidersTabResponder();
    const before = useModelPickerIntentStore.getState().openProvidersTabNonce;
    render(<ErrorBox message={message} code="provider_not_allowlisted" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Use your own provider key" })
    );

    expect(useModelPickerIntentStore.getState().openProvidersTabNonce).toBe(
      before + 1
    );
    release();
  });

  it("offers no provider-key button when no model picker can open", () => {
    // e.g. a hosted study chat in minimal mode, which mounts no picker.
    useModelPickerIntentStore.setState({ providersTabResponderCount: 0 });
    render(<ErrorBox message={message} code="provider_not_allowlisted" />);

    expect(
      screen.getByTestId("chat-error-provider-not-allowlisted")
    ).toHaveTextContent(/BYOK/);
    expect(
      screen.queryByRole("button", { name: "Use your own provider key" })
    ).not.toBeInTheDocument();
  });

  it("falls back to the catalog sentence when the message is blank", () => {
    render(<ErrorBox message="" code="provider_not_allowlisted" />);

    expect(
      screen.getByTestId("chat-error-provider-not-allowlisted")
    ).toHaveTextContent("Retrying or changing your API key won't help.");
  });
});
