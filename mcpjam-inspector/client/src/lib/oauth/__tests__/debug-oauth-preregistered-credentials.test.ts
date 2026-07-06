import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_OAUTH_FLOW_STATE,
  type OAuthFlowState,
} from "@mcpjam/sdk/browser";
import { createInspectorOAuthStateMachine } from "../debug-state-machine-adapter";

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

const SERVER_NAME = "Test Server";
const CLIENT_ID = "client_from_profile";
const CLIENT_SECRET = "s3cr3t-from-profile";

type ProtocolVersion = "2025-03-26" | "2025-06-18" | "2025-11-25";

function createPreregisteredHarness(options: {
  protocolVersion: ProtocolVersion;
  preregisteredClientId?: string;
  preregisteredClientSecret?: string;
  tokenEndpointAuthMethodsSupported?: string[];
}) {
  const authorizationServerMetadata = {
    issuer: "https://auth.example.com",
    authorization_endpoint: "https://auth.example.com/authorize",
    token_endpoint: "https://auth.example.com/token",
    response_types_supported: ["code"],
    ...(options.tokenEndpointAuthMethodsSupported
      ? {
          token_endpoint_auth_methods_supported:
            options.tokenEndpointAuthMethodsSupported,
        }
      : {}),
  } as OAuthFlowState["authorizationServerMetadata"];

  let state: OAuthFlowState = {
    ...EMPTY_OAUTH_FLOW_STATE,
    currentStep: "received_authorization_server_metadata",
    authorizationServerMetadata,
    httpHistory: [],
    infoLogs: [],
  };

  const updateState = (updates: Partial<OAuthFlowState>) => {
    state = { ...state, ...updates };
  };

  const machine = createInspectorOAuthStateMachine({
    protocolVersion: options.protocolVersion,
    state,
    getState: () => state,
    updateState,
    serverUrl: "https://mcp.example.com",
    serverName: SERVER_NAME,
    registrationStrategy: "preregistered",
    preregisteredClientId: options.preregisteredClientId,
    preregisteredClientSecret: options.preregisteredClientSecret,
  });

  return {
    machine,
    getState: () => state,
    updateState,
  };
}

describe("OAuth debugger pre-registered client credentials (#3029)", () => {
  afterEach(() => {
    localStorage.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each<{ protocolVersion: ProtocolVersion }>([
    { protocolVersion: "2025-03-26" },
    { protocolVersion: "2025-06-18" },
    { protocolVersion: "2025-11-25" },
  ])(
    "$protocolVersion resolves a confidential client from the configured profile credentials",
    async ({ protocolVersion }) => {
      const { machine, getState } = createPreregisteredHarness({
        protocolVersion,
        preregisteredClientId: CLIENT_ID,
        preregisteredClientSecret: CLIENT_SECRET,
      });

      await machine.proceedToNextStep();

      expect(getState().currentStep).toBe("received_client_credentials");
      expect(getState().clientId).toBe(CLIENT_ID);
      expect(getState().clientSecret).toBe(CLIENT_SECRET);
      expect(getState().tokenEndpointAuthMethod).toBe("client_secret_basic");
    },
  );

  it("does not fall back to 'none' when the AS also advertises it (WorkOS-style metadata)", async () => {
    const { machine, getState } = createPreregisteredHarness({
      protocolVersion: "2025-11-25",
      preregisteredClientId: CLIENT_ID,
      preregisteredClientSecret: CLIENT_SECRET,
      tokenEndpointAuthMethodsSupported: [
        "none",
        "client_secret_post",
        "client_secret_basic",
      ],
    });

    await machine.proceedToNextStep();

    expect(getState().tokenEndpointAuthMethod).toBe("client_secret_basic");
    expect(getState().clientSecret).toBe(CLIENT_SECRET);
  });

  it("includes the client_secret in the token request body (client_secret_post)", async () => {
    vi.useFakeTimers();
    const { machine, getState, updateState } = createPreregisteredHarness({
      protocolVersion: "2025-11-25",
      preregisteredClientId: CLIENT_ID,
      preregisteredClientSecret: CLIENT_SECRET,
      // Pin the AS to client_secret_post so the body-borne secret asserted
      // below is the spec-correct transport. NOTE: the debug state machines
      // currently transmit the secret in the body even when the resolved
      // method is client_secret_basic (no Authorization: Basic header is
      // built anywhere) — tracked as a follow-up SDK issue.
      tokenEndpointAuthMethodsSupported: ["client_secret_post"],
    });

    await machine.proceedToNextStep();
    expect(getState().currentStep).toBe("received_client_credentials");
    expect(getState().tokenEndpointAuthMethod).toBe("client_secret_post");

    updateState({
      currentStep: "received_authorization_code",
      authorizationCode: "auth-code-123",
      codeVerifier: "pkce-verifier",
    });

    await machine.proceedToNextStep();

    expect(getState().currentStep).toBe("token_request");
    expect(getState().lastRequest).toMatchObject({
      method: "POST",
      url: "https://auth.example.com/token",
      body: {
        grant_type: "authorization_code",
        code: "auth-code-123",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
      },
    });
  });

  it("stays a public client when no secret is configured", async () => {
    vi.useFakeTimers();
    const { machine, getState, updateState } = createPreregisteredHarness({
      protocolVersion: "2025-11-25",
      preregisteredClientId: CLIENT_ID,
    });

    await machine.proceedToNextStep();

    expect(getState().tokenEndpointAuthMethod).toBe("none");
    expect(getState().clientSecret).toBeUndefined();

    updateState({
      currentStep: "received_authorization_code",
      authorizationCode: "auth-code-123",
      codeVerifier: "pkce-verifier",
    });

    await machine.proceedToNextStep();

    expect(getState().lastRequest?.body).not.toHaveProperty("client_secret");
  });

  it("prefers the profile clientId over a stored DCR client record", async () => {
    localStorage.setItem(
      `mcp-client-${SERVER_NAME}`,
      JSON.stringify({ client_id: "stale_dcr_client" }),
    );

    const { machine, getState } = createPreregisteredHarness({
      protocolVersion: "2025-11-25",
      preregisteredClientId: CLIENT_ID,
      preregisteredClientSecret: CLIENT_SECRET,
    });

    await machine.proceedToNextStep();

    expect(getState().clientId).toBe(CLIENT_ID);
    expect(getState().clientSecret).toBe(CLIENT_SECRET);
  });

  it("falls back to the stored client record when the profile has no credentials", async () => {
    localStorage.setItem(
      `mcp-client-${SERVER_NAME}`,
      JSON.stringify({ client_id: "stored_client" }),
    );

    const { machine, getState } = createPreregisteredHarness({
      protocolVersion: "2025-11-25",
    });

    await machine.proceedToNextStep();

    expect(getState().clientId).toBe("stored_client");
  });

  it("does not pair a profile secret with a stored client id", async () => {
    localStorage.setItem(
      `mcp-client-${SERVER_NAME}`,
      JSON.stringify({ client_id: "stale_dcr_client" }),
    );

    const { machine, getState } = createPreregisteredHarness({
      protocolVersion: "2025-11-25",
      preregisteredClientSecret: CLIENT_SECRET,
    });

    await machine.proceedToNextStep();

    // A secret belongs to a specific client id. Adopting the stored (possibly
    // stale DCR) id would authenticate as the wrong client, so the machine
    // fails fast and asks for the missing client id instead.
    expect(getState().clientId).toBeUndefined();
    expect(getState().error).toMatch(/client ID is required/i);
  });
});
