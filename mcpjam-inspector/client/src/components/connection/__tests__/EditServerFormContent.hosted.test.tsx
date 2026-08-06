import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HOSTED_LOCAL_ONLY_TOOLTIP } from "@/lib/hosted-ui";

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { email: "tester@example.com" } }),
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/components/connection/shared/AuthenticationSection", () => ({
  AuthenticationSection: () => <div data-testid="auth-section" />,
}));

/** Records what the real section would have been handed, and exposes the
 * "section was opened" callback as a button so the fetch can be driven. */
const sectionProps = vi.hoisted(() => ({
  advanced: null as Record<string, unknown> | null,
  env: null as Record<string, unknown> | null,
}));

const secretKeysApi = vi.hoisted(() => ({
  fetchServerSecretKeys: vi.fn(),
  fetchServerSecrets: vi.fn(),
}));

vi.mock("@/lib/apis/server-secrets-api", () => secretKeysApi);

vi.mock(
  "@/components/connection/shared/AdvancedConnectionSettingsSection",
  () => ({
    AdvancedConnectionSettingsSection: (props: Record<string, unknown>) => {
      sectionProps.advanced = props;
      return (
        <div data-testid="advanced-settings-section">
          <button
            type="button"
            onClick={() =>
              (props.onRequestStoredKeys as (() => void) | undefined)?.()
            }
          >
            open headers
          </button>
        </div>
      );
    },
  }),
);

vi.mock("@/components/connection/shared/CustomHeadersSection", () => ({
  CustomHeadersSection: () => <div data-testid="custom-headers-section" />,
}));

vi.mock("@/components/connection/shared/EnvVarsSection", () => ({
  EnvVarsSection: (props: Record<string, unknown>) => {
    sectionProps.env = props;
    return (
      <div data-testid="env-section">
        <button
          type="button"
          onClick={() =>
            (props.onRequestStoredKeys as (() => void) | undefined)?.()
          }
        >
          open env
        </button>
      </div>
    );
  },
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
    registrationMode: "auto",
    setOauthRegistrationMode: vi.fn(),
    xaaClientAuth: "none",
    setXaaClientAuth: vi.fn(),
    confidentialCimdCapability: {
      status: "unavailable",
      clientIdMetadataUrl: null,
      error: null,
      retry: vi.fn(),
    },
    confidentialCimdBlockReason: null,
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

describe("EditServerFormContent stored key names", () => {
  beforeEach(() => {
    sectionProps.advanced = null;
    sectionProps.env = null;
    secretKeysApi.fetchServerSecretKeys.mockReset();
    secretKeysApi.fetchServerSecrets.mockReset();
    secretKeysApi.fetchServerSecretKeys.mockResolvedValue({
      envKeys: ["OPENAI_API_KEY"],
      headerKeys: ["Authorization", "X-Tenant"],
    });
  });

  async function openHeaders(formStateOverrides: Record<string, unknown>) {
    render(
      <EditServerFormContent
        formState={createFormState({
          type: "http",
          hasStoredHeaders: true,
          showConfiguration: true,
          ...formStateOverrides,
        })}
        isDuplicateServerName={false}
        projectId="proj_1"
        hostedServerId="srv_1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "open headers" }));
    await waitFor(() =>
      expect(secretKeysApi.fetchServerSecretKeys).toHaveBeenCalledTimes(1),
    );
  }

  it("keeps a stored Authorization header as a row when it isn't the bearer token", async () => {
    // An OAuth/none server can carry its own Authorization header (Basic auth,
    // say). `revealStoredHeaders` leaves that as a custom header row, so
    // dropping it from the names would hide a row that reappears the moment
    // the values land.
    await openHeaders({ authType: "none", hasStoredBearerToken: false });

    await waitFor(() =>
      expect(sectionProps.advanced?.storedHeaderKeys).toEqual([
        "Authorization",
        "X-Tenant",
      ]),
    );
  });

  it("drops Authorization from the names when the reveal would make it the bearer token", async () => {
    await openHeaders({ authType: "bearer", hasStoredBearerToken: true });

    await waitFor(() =>
      expect(sectionProps.advanced?.storedHeaderKeys).toEqual(["X-Tenant"]),
    );
  });

  it("fetches names once for both sections and never the values", async () => {
    render(
      <EditServerFormContent
        formState={createFormState({
          type: "stdio",
          hasStoredEnv: true,
          showEnvVars: true,
        })}
        isDuplicateServerName={false}
        projectId="proj_1"
        hostedServerId="srv_1"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "open env" }));

    await waitFor(() =>
      expect(sectionProps.env?.storedEnvKeys).toEqual(["OPENAI_API_KEY"]),
    );
    // Opening a disclosure asks which keys exist. Reading one is the eye's job.
    expect(secretKeysApi.fetchServerSecrets).not.toHaveBeenCalled();
  });
});
