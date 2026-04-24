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
      screen.getByText("Automatic order: preregistered -> CIMD -> DCR"),
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

    expect(screen.getByText("Scope Override")).toBeInTheDocument();
    expect(
      screen.getByText("Use pre-registered OAuth credentials"),
    ).toBeInTheDocument();
  });
});
