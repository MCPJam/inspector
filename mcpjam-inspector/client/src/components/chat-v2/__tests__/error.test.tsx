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
  it("shows a BYOK balance error without retry or MCPJam credit prompts", () => {
    const message =
      "Your Anthropic API account has insufficient credits. Add credits in Anthropic or use another API key.";
    render(
      <ErrorBox message={message} code="provider_error" isRetryable={false}
        onRetry={vi.fn()} onResetChat={vi.fn()} />,
    );
    expect(screen.getByText(message, { exact: false })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /retry/i }))
      .not.toBeInTheDocument();
    expect(screen.queryByText(/buy.*credits|MCPJam credits/i))
      .not.toBeInTheDocument();
    expect(useMCPJamLimitDialogStore.getState().isOpen).toBe(false);
  });

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

describe("ErrorBox organization AI-key refusals", () => {
  beforeEach(() => {
    useModelPickerIntentStore.setState({ providersTabResponderCount: 0 });
  });

  it("offers an admin Manage AI providers and never a top-up or retry", () => {
    const onManageOrgProviders = vi.fn();
    render(
      <ErrorBox
        message="This organization requires its own provider keys."
        code="org_keys_required"
        isRetryable={false}
        canTopUp
        onTopUp={vi.fn()}
        onRetry={vi.fn()}
        onManageOrgProviders={onManageOrgProviders}
      />,
    );

    expect(screen.getByTestId("chat-error-org-keys")).toHaveAttribute(
      "data-refusal-code",
      "org_keys_required",
    );
    expect(
      screen.getByText("Organization provider required"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage AI providers" }));
    expect(onManageOrgProviders).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /credits|retry/i })).toBeNull();
  });

  it("tells a member to ask an organization admin", () => {
    render(
      <ErrorBox
        message="refused"
        code="provider_auth_failed"
        onResetChat={vi.fn()}
      />,
    );

    expect(screen.getByText(/ask an organization admin/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Manage AI providers" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Reset chat" })).toBeInTheDocument();
  });

  it("reads the code from the details envelope (credential_missing from /stream/org)", () => {
    render(
      <ErrorBox
        message="refused"
        errorDetails={JSON.stringify({ code: "credential_missing" })}
      />,
    );

    expect(screen.getByTestId("chat-error-org-keys")).toHaveAttribute(
      "data-refusal-code",
      "credential_missing",
    );
    expect(screen.getByText(/ask an organization admin/i)).toBeInTheDocument();
  });

  it("opens the model picker to choose an organization model when one is mounted", () => {
    const unregister = useModelPickerIntentStore
      .getState()
      .registerProvidersTabResponder();
    const before = useModelPickerIntentStore.getState().openProvidersTabNonce;
    render(<ErrorBox message="refused" code="org_keys_required" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Choose an organization model" }),
    );
    expect(useModelPickerIntentStore.getState().openProvidersTabNonce).toBe(
      before + 1,
    );
    unregister();
  });

  it("shows Ask MCPJam's org_runtime_unsupported with no model to choose and no retry", () => {
    const unregister = useModelPickerIntentStore
      .getState()
      .registerProvidersTabResponder();
    render(
      <ErrorBox
        message="Ask MCPJam can't run on this organization's providers yet."
        code="org_runtime_unsupported"
        isRetryable={false}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByTestId("chat-error-org-keys")).toHaveAttribute(
      "data-refusal-code",
      "org_runtime_unsupported",
    );
    expect(
      screen.getByText("Unavailable with organization keys"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Choose an organization model" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    // Nothing to ask an admin for: the feature itself can't run.
    expect(screen.queryByText(/ask an organization admin/i)).toBeNull();
    unregister();
  });

  it("lets the actions wrap under the text instead of squeezing it", () => {
    render(
      <ErrorBox
        message="refused"
        code="org_keys_required"
        onManageOrgProviders={vi.fn()}
        onResetChat={vi.fn()}
      />,
    );

    // A narrow pane wraps the action row onto its own line; a fixed-width
    // row would leave the text one word wide.
    expect(screen.getByTestId("chat-error-org-keys-layout")).toHaveClass(
      "flex-wrap",
    );
    expect(screen.getByTestId("chat-error-org-keys-actions")).not.toHaveClass(
      "flex-shrink-0",
    );
  });

  it("offers a retry only for the transient refusals", () => {
    const onRetry = vi.fn();
    render(
      <ErrorBox message="busy" code="provider_unavailable" onRetry={onRetry} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
