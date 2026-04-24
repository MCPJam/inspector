import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthenticationSection } from "../shared/AuthenticationSection";

describe("AuthenticationSection", () => {
  it("does not show the OAuth plan explainer for a typical automatic OAuth setup", () => {
    render(
      <AuthenticationSection
        serverUrl="https://example.com/mcp"
        authType="oauth"
        onAuthTypeChange={vi.fn()}
        showAuthSettings={true}
        bearerToken=""
        onBearerTokenChange={vi.fn()}
        oauthScopesInput=""
        onOauthScopesChange={vi.fn()}
        oauthProtocolMode="2025-11-25"
        onOauthProtocolModeChange={vi.fn()}
        oauthRegistrationMode="auto"
        onOauthRegistrationModeChange={vi.fn()}
        useCustomClientId={false}
        onUseCustomClientIdChange={vi.fn()}
        clientId=""
        onClientIdChange={vi.fn()}
        clientSecret=""
        onClientSecretChange={vi.fn()}
        clientIdError={null}
        clientSecretError={null}
      />,
    );

    expect(
      screen.queryByText(/Uses the SDK planner to resolve pre-registered credentials/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Automatic order: pre-registered -> CIMD -> DCR"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /advanced settings/i })).toBeInTheDocument();
  });

  it("does not show the preregistered client ID banner; marks Client ID as required", () => {
    render(
      <AuthenticationSection
        serverUrl="https://example.com/mcp"
        authType="oauth"
        onAuthTypeChange={vi.fn()}
        showAuthSettings={true}
        bearerToken=""
        onBearerTokenChange={vi.fn()}
        oauthScopesInput=""
        onOauthScopesChange={vi.fn()}
        oauthProtocolMode="2025-11-25"
        onOauthProtocolModeChange={vi.fn()}
        oauthRegistrationMode="preregistered"
        onOauthRegistrationModeChange={vi.fn()}
        useCustomClientId={true}
        onUseCustomClientIdChange={vi.fn()}
        clientId=""
        onClientIdChange={vi.fn()}
        clientSecret=""
        onClientSecretChange={vi.fn()}
        clientIdError={null}
        clientSecretError={null}
      />,
    );

    expect(
      screen.queryByText(/Pre-registered OAuth requires a client ID/i),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /advanced settings/i }));

    const clientIdLabel = screen.getByText("Client ID");
    expect(clientIdLabel.textContent).toMatch(/\*/);
    expect(
      screen.getByPlaceholderText("Your OAuth Client ID"),
    ).toHaveAttribute("aria-required", "true");
  });

  it("shows manual scope and credential overrides when expanded", () => {
    render(
      <AuthenticationSection
        serverUrl="https://example.com/mcp"
        authType="oauth"
        onAuthTypeChange={vi.fn()}
        showAuthSettings={true}
        bearerToken=""
        onBearerTokenChange={vi.fn()}
        oauthScopesInput=""
        onOauthScopesChange={vi.fn()}
        oauthProtocolMode="2025-11-25"
        onOauthProtocolModeChange={vi.fn()}
        oauthRegistrationMode="auto"
        onOauthRegistrationModeChange={vi.fn()}
        useCustomClientId={false}
        onUseCustomClientIdChange={vi.fn()}
        clientId=""
        onClientIdChange={vi.fn()}
        clientSecret=""
        onClientSecretChange={vi.fn()}
        clientIdError={null}
        clientSecretError={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /advanced settings/i }));

    expect(screen.getByText("Protocol")).toBeInTheDocument();
    expect(screen.getByText("Registration Strategy")).toBeInTheDocument();
    expect(screen.getByText("Scope Override")).toBeInTheDocument();
  });

  it("reflects a registration strategy override in Advanced Settings", () => {
    render(
      <AuthenticationSection
        serverUrl="https://example.com/mcp"
        authType="oauth"
        onAuthTypeChange={vi.fn()}
        showAuthSettings={true}
        bearerToken=""
        onBearerTokenChange={vi.fn()}
        oauthScopesInput=""
        onOauthScopesChange={vi.fn()}
        oauthProtocolMode="2025-11-25"
        onOauthProtocolModeChange={vi.fn()}
        oauthRegistrationMode="cimd"
        onOauthRegistrationModeChange={vi.fn()}
        useCustomClientId={false}
        onUseCustomClientIdChange={vi.fn()}
        clientId=""
        onClientIdChange={vi.fn()}
        clientSecret=""
        onClientSecretChange={vi.fn()}
        clientIdError={null}
        clientSecretError={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /advanced settings/i }));

    expect(
      screen.getByText("Client ID Metadata Documents (CIMD)"),
    ).toBeInTheDocument();
  });
});
