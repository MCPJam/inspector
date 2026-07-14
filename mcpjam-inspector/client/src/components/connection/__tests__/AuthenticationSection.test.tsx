import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AuthenticationSection } from "../shared/AuthenticationSection";
import { fetchOAuthClientSecret } from "@/lib/apis/hosted-oauth-client-secret-api";

vi.mock("@/lib/apis/hosted-oauth-client-secret-api", () => ({
  fetchOAuthClientSecret: vi.fn(),
}));

let xaaFlagValue: boolean | undefined = undefined;
vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) =>
    flag === "xaa" ? xaaFlagValue : undefined,
}));

const fetchOAuthClientSecretMock = vi.mocked(fetchOAuthClientSecret);

const hostedSecretProps = {
  serverUrl: "https://example.com/mcp",
  authType: "oauth" as const,
  onAuthTypeChange: vi.fn(),
  showAuthSettings: true,
  bearerToken: "",
  onBearerTokenChange: vi.fn(),
  oauthScopesInput: "",
  onOauthScopesChange: vi.fn(),
  oauthProtocolMode: "2025-11-25" as const,
  onOauthProtocolModeChange: vi.fn(),
  registrationMode: "preregistered" as const,
  onOauthRegistrationModeChange: vi.fn(),
  useCustomClientId: true,
  onUseCustomClientIdChange: vi.fn(),
  clientId: "client-id",
  onClientIdChange: vi.fn(),
  clientSecret: "",
  onClientSecretChange: vi.fn(),
  hasStoredClientSecret: true,
  clientIdError: null,
  clientSecretError: null,
  projectId: "project-1",
  hostedServerId: "server-1",
};

describe("AuthenticationSection", () => {
  beforeEach(() => {
    xaaFlagValue = undefined;
  });

  it("hides the Cross-App Access (XAA) option when the xaa flag is off", async () => {
    xaaFlagValue = false;
    render(
      <AuthenticationSection
        serverUrl="https://example.com/mcp"
        authType="none"
        onAuthTypeChange={vi.fn()}
        showAuthSettings={false}
        bearerToken=""
        onBearerTokenChange={vi.fn()}
        oauthScopesInput=""
        onOauthScopesChange={vi.fn()}
        oauthProtocolMode="2025-11-25"
        onOauthProtocolModeChange={vi.fn()}
        registrationMode="auto"
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

    await userEvent.click(screen.getByRole("combobox"));
    expect(
      screen.queryByText("Cross-App Access (XAA)"),
    ).not.toBeInTheDocument();
  });

  it("shows the Cross-App Access (XAA) option when the xaa flag is enabled", async () => {
    xaaFlagValue = true;
    render(
      <AuthenticationSection
        serverUrl="https://example.com/mcp"
        authType="none"
        onAuthTypeChange={vi.fn()}
        showAuthSettings={false}
        bearerToken=""
        onBearerTokenChange={vi.fn()}
        oauthScopesInput=""
        onOauthScopesChange={vi.fn()}
        oauthProtocolMode="2025-11-25"
        onOauthProtocolModeChange={vi.fn()}
        registrationMode="auto"
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

    await userEvent.click(screen.getByRole("combobox"));
    expect(screen.getByText("Cross-App Access (XAA)")).toBeInTheDocument();
  });

  it("keeps the Cross-App Access (XAA) option visible for a server already using it, even when the flag is off", async () => {
    xaaFlagValue = false;
    render(
      <AuthenticationSection
        serverUrl="https://example.com/mcp"
        authType="xaa"
        onAuthTypeChange={vi.fn()}
        showAuthSettings={true}
        bearerToken=""
        onBearerTokenChange={vi.fn()}
        oauthScopesInput=""
        onOauthScopesChange={vi.fn()}
        oauthProtocolMode="2025-11-25"
        onOauthProtocolModeChange={vi.fn()}
        registrationMode="auto"
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

    expect(screen.getByText("Cross-App Access (XAA)")).toBeInTheDocument();
  });

  const autoProps = {
    serverUrl: "https://example.com/mcp",
    authType: "auto" as const,
    onAuthTypeChange: vi.fn(),
    showAuthSettings: false,
    bearerToken: "",
    onBearerTokenChange: vi.fn(),
    oauthScopesInput: "",
    onOauthScopesChange: vi.fn(),
    oauthProtocolMode: "2025-11-25" as const,
    onOauthProtocolModeChange: vi.fn(),
    registrationMode: "auto" as const,
    onOauthRegistrationModeChange: vi.fn(),
    useCustomClientId: false,
    onUseCustomClientIdChange: vi.fn(),
    clientId: "",
    onClientIdChange: vi.fn(),
    clientSecret: "",
    onClientSecretChange: vi.fn(),
    clientIdError: null,
    clientSecretError: null,
  };

  it("shows only the Auto label in the closed trigger; the description only in the open menu", async () => {
    xaaFlagValue = true;
    render(<AuthenticationSection {...autoProps} />);

    const trigger = screen.getByRole("combobox");
    expect(trigger).toHaveTextContent("Auto");
    expect(
      screen.queryByText(
        "Uses Cross-App Access when configured, otherwise OAuth",
      ),
    ).not.toBeInTheDocument();

    await userEvent.click(trigger);
    expect(
      screen.getByText("Uses Cross-App Access when configured, otherwise OAuth"),
    ).toBeInTheDocument();
  });

  it("keeps the Auto option visible for a server saved as auto, even when the flag is off", () => {
    xaaFlagValue = false;
    render(<AuthenticationSection {...autoProps} />);

    expect(screen.getByRole("combobox")).toHaveTextContent("Auto");
  });

  it("explains Auto per-server: OAuth when XAA is not configured", () => {
    xaaFlagValue = true;
    render(<AuthenticationSection {...autoProps} autoSelectsXaa={false} />);

    expect(screen.getByText("Auto will use OAuth.")).toBeInTheDocument();
  });

  it("explains Auto per-server: XAA when configured", () => {
    xaaFlagValue = true;
    render(<AuthenticationSection {...autoProps} autoSelectsXaa={true} />);

    expect(
      screen.getByText(
        "Cross-App Access is configured — connecting mints a cross-app token.",
      ),
    ).toBeInTheDocument();
  });

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
        registrationMode="auto"
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

  it("masks the bearer token but allows revealing it", () => {
    render(
      <AuthenticationSection
        serverUrl="https://example.com/mcp"
        authType="bearer"
        onAuthTypeChange={vi.fn()}
        showAuthSettings={true}
        bearerToken="super-secret-token"
        onBearerTokenChange={vi.fn()}
        oauthScopesInput=""
        onOauthScopesChange={vi.fn()}
        oauthProtocolMode="2025-11-25"
        onOauthProtocolModeChange={vi.fn()}
        registrationMode="auto"
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

    const input = screen.getByPlaceholderText("Enter your bearer token");
    expect(input).toHaveAttribute("type", "password");

    fireEvent.click(screen.getByRole("button", { name: /show bearer token/i }));
    expect(input).toHaveAttribute("type", "text");

    fireEvent.click(screen.getByRole("button", { name: /hide bearer token/i }));
    expect(input).toHaveAttribute("type", "password");
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
        registrationMode="preregistered"
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
        registrationMode="auto"
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
        registrationMode="cimd"
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

  it("shows stored client secret metadata with clear and undo actions", () => {
    const onClearClientSecret = vi.fn();
    const onUndoClearClientSecret = vi.fn();
    const props = {
      serverUrl: "https://example.com/mcp",
      authType: "oauth" as const,
      onAuthTypeChange: vi.fn(),
      showAuthSettings: true,
      bearerToken: "",
      onBearerTokenChange: vi.fn(),
      oauthScopesInput: "",
      onOauthScopesChange: vi.fn(),
      oauthProtocolMode: "2025-11-25" as const,
      onOauthProtocolModeChange: vi.fn(),
      registrationMode: "preregistered" as const,
      onOauthRegistrationModeChange: vi.fn(),
      useCustomClientId: true,
      onUseCustomClientIdChange: vi.fn(),
      clientId: "client-id",
      onClientIdChange: vi.fn(),
      clientSecret: "",
      onClientSecretChange: vi.fn(),
      hasStoredClientSecret: true,
      clientIdError: null,
      clientSecretError: null,
      onClearClientSecret,
      onUndoClearClientSecret,
    };

    const { rerender } = render(<AuthenticationSection {...props} />);

    fireEvent.click(screen.getByRole("button", { name: /advanced settings/i }));

    expect(
      screen.getByPlaceholderText("Enter a new value to replace."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onClearClientSecret).toHaveBeenCalledTimes(1);

    rerender(<AuthenticationSection {...props} clearClientSecret={true} />);

    expect(
      screen.getByText("Saved client secret will be removed when you save."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndoClearClientSecret).toHaveBeenCalledTimes(1);
  });

  it("hides the secret input until revealed when a stored secret can be revealed", () => {
    render(<AuthenticationSection {...hostedSecretProps} />);

    fireEvent.click(screen.getByRole("button", { name: /advanced settings/i }));

    // No always-on replace box while the saved secret is hidden.
    expect(
      screen.queryByPlaceholderText("Enter a new value to replace."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/A client secret is saved/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Reveal" }),
    ).toBeInTheDocument();
  });

  it("reveals the saved secret into an editable box that replaces on edit", async () => {
    fetchOAuthClientSecretMock.mockResolvedValue({
      clientSecret: "sk-stored-secret",
    });
    const onClientSecretChange = vi.fn();
    render(
      <AuthenticationSection
        {...hostedSecretProps}
        onClientSecretChange={onClientSecretChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /advanced settings/i }));
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));

    const input = (await screen.findByTestId(
      "revealed-client-secret",
    )) as HTMLInputElement;
    expect(input.value).toBe("sk-stored-secret");

    fireEvent.change(input, { target: { value: "sk-new-secret" } });
    expect(onClientSecretChange).toHaveBeenLastCalledWith("sk-new-secret");

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    await waitFor(() =>
      expect(
        screen.queryByTestId("revealed-client-secret"),
      ).not.toBeInTheDocument(),
    );
  });

  it("clears a pending replacement when Clear is clicked", async () => {
    fetchOAuthClientSecretMock.mockResolvedValue({
      clientSecret: "sk-stored-secret",
    });

    function Harness() {
      const [clientSecret, setClientSecret] = useState("");
      const [clearClientSecret, setClearClientSecret] = useState(false);

      return (
        <>
          <AuthenticationSection
            {...hostedSecretProps}
            clientSecret={clientSecret}
            onClientSecretChange={setClientSecret}
            clearClientSecret={clearClientSecret}
            onClearClientSecret={() => setClearClientSecret(true)}
          />
          <output data-testid="client-secret-state">{clientSecret}</output>
          <output data-testid="clear-secret-state">
            {String(clearClientSecret)}
          </output>
        </>
      );
    }

    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: /advanced settings/i }));
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));

    const input = (await screen.findByTestId(
      "revealed-client-secret",
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sk-new-secret" } });
    expect(screen.getByTestId("client-secret-state")).toHaveTextContent(
      "sk-new-secret",
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(screen.getByTestId("client-secret-state")).toHaveTextContent("");
    expect(screen.getByTestId("clear-secret-state")).toHaveTextContent("true");
  });

  it("forgets a revealed secret when the hosted server context changes", async () => {
    fetchOAuthClientSecretMock.mockResolvedValue({
      clientSecret: "sk-stored-secret",
    });

    const { rerender } = render(
      <AuthenticationSection {...hostedSecretProps} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /advanced settings/i }));
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));

    const input = (await screen.findByTestId(
      "revealed-client-secret",
    )) as HTMLInputElement;
    expect(input.value).toBe("sk-stored-secret");

    rerender(
      <AuthenticationSection {...hostedSecretProps} hostedServerId="server-2" />,
    );

    expect(screen.queryByTestId("revealed-client-secret")).not.toBeInTheDocument();
    expect(screen.getByText(/A client secret is saved/i)).toBeInTheDocument();
  });
});
