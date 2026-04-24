import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthenticationSection } from "../shared/AuthenticationSection";

describe("AuthenticationSection", () => {
  it("renders the MCP authorization plan summary for OAuth connections", () => {
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
        oauthProtocolMode="auto"
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

    expect(screen.getAllByText("MCP Authorization").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Uses the SDK planner to resolve pre-registered credentials/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Automatic order: pre-registered -> CIMD -> DCR"),
    ).toBeInTheDocument();
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
        oauthProtocolMode="auto"
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

    fireEvent.click(screen.getByRole("button", { name: /manual overrides/i }));

    expect(screen.getByText("Protocol")).toBeInTheDocument();
    expect(screen.getByText("Registration Strategy")).toBeInTheDocument();
    expect(screen.getByText("Scope Override")).toBeInTheDocument();
    expect(
      screen.getByText(/Automatic discovery uses pre-registered credentials/i),
    ).toBeInTheDocument();
  });

  it("shows an explicit registration override summary when developers choose one", () => {
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

    expect(
      screen.getByText("Registration override: Client ID Metadata Documents (CIMD)"),
    ).toBeInTheDocument();
  });
});
