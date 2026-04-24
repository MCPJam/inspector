import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HOSTED_LOCAL_ONLY_TOOLTIP } from "@/lib/hosted-ui";

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/components/connection/shared/AuthenticationSection", () => ({
  AuthenticationSection: () => <div data-testid="auth-section" />,
}));

vi.mock(
  "@/components/connection/shared/AdvancedConnectionSettingsSection",
  () => ({
    AdvancedConnectionSettingsSection: () => (
      <div data-testid="advanced-settings-section" />
    ),
  }),
);

vi.mock("@/components/connection/shared/CustomHeadersSection", () => ({
  CustomHeadersSection: () => <div data-testid="custom-headers-section" />,
}));

vi.mock("@/components/connection/shared/EnvVarsSection", () => ({
  EnvVarsSection: () => <div data-testid="env-section" />,
}));

import { EditServerFormContent } from "../EditServerFormContent";

function createFormState(overrides: Record<string, unknown> = {}) {
  return {
    name: "Hosted server",
    setName: vi.fn(),
    type: "http",
    commandInput: "",
    setCommandInput: vi.fn(),
    url: "",
    setUrl: vi.fn(),
    authType: "none",
    setAuthType: vi.fn(),
    showAuthSettings: false,
    setShowAuthSettings: vi.fn(),
    bearerToken: "",
    setBearerToken: vi.fn(),
    oauthScopesInput: "",
    setOauthScopesInput: vi.fn(),
    oauthProtocolMode: "2025-11-25",
    setOauthProtocolMode: vi.fn(),
    oauthRegistrationMode: "auto",
    setOauthRegistrationMode: vi.fn(),
    useCustomClientId: false,
    setUseCustomClientId: vi.fn(),
    clientId: "",
    setClientId: vi.fn(),
    clientIdError: null,
    setClientIdError: vi.fn(),
    clientSecret: "",
    setClientSecret: vi.fn(),
    clientSecretError: null,
    setClientSecretError: vi.fn(),
    validateClientId: vi.fn().mockReturnValue(null),
    validateClientSecret: vi.fn().mockReturnValue(null),
    envVars: [],
    showEnvVars: false,
    setShowEnvVars: vi.fn(),
    addEnvVar: vi.fn(),
    removeEnvVar: vi.fn(),
    updateEnvVar: vi.fn(),
    customHeaders: [],
    addCustomHeader: vi.fn(),
    removeCustomHeader: vi.fn(),
    updateCustomHeader: vi.fn(),
    requestTimeout: "",
    setRequestTimeout: vi.fn(),
    inheritedRequestTimeout: 10000,
    clientCapabilitiesOverrideEnabled: false,
    setClientCapabilitiesOverrideEnabled: vi.fn(),
    clientCapabilitiesOverrideText: "{}",
    setClientCapabilitiesOverrideText: vi.fn(),
    clientCapabilitiesOverrideError: null,
    setClientCapabilitiesOverrideError: vi.fn(),
    showConfiguration: false,
    setShowConfiguration: vi.fn(),
    ...overrides,
  };
}

describe("EditServerFormContent hosted mode", () => {
  it("shows HTTPS and reveals grayed-out hosted-only alternatives", async () => {
    render(
      <EditServerFormContent
        formState={createFormState()}
        isDuplicateServerName={false}
      />,
    );

    expect(screen.getByLabelText("Connection Type")).toHaveTextContent("HTTPS");
    expect(
      screen.getByPlaceholderText("https://example.com/mcp"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Connection Type" }));

    const menu = screen.getByTestId("hosted-connection-type-options");
    expect(within(menu).getByText("HTTPS")).toBeInTheDocument();
    expect(within(menu).getByText("HTTP")).toBeInTheDocument();
    expect(within(menu).getByText("STDIO")).toBeInTheDocument();
    expect(within(menu).getAllByTitle(HOSTED_LOCAL_ONLY_TOOLTIP)).toHaveLength(
      2,
    );

    fireEvent.pointerMove(
      within(menu).getAllByTitle(HOSTED_LOCAL_ONLY_TOOLTIP)[0],
    );
    await waitFor(() => {
      expect(
        screen.getAllByText(HOSTED_LOCAL_ONLY_TOOLTIP).length,
      ).toBeGreaterThan(0);
    });
  });

  it("still opens the hosted menu for legacy stdio servers", () => {
    render(
      <EditServerFormContent
        formState={createFormState({ type: "stdio" })}
        isDuplicateServerName={false}
      />,
    );

    expect(screen.getByLabelText("Connection Type")).toHaveTextContent("STDIO");
    expect(
      screen.getByPlaceholderText(
        "npx -y @modelcontextprotocol/server-everything",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Connection Type" }));

    const menu = screen.getByTestId("hosted-connection-type-options");
    expect(within(menu).getByText("HTTPS")).toBeInTheDocument();
    expect(within(menu).getByText("HTTP")).toBeInTheDocument();
    expect(within(menu).getByText("STDIO")).toBeInTheDocument();
    expect(within(menu).getAllByTitle(HOSTED_LOCAL_ONLY_TOOLTIP)).toHaveLength(
      2,
    );
  });
});
