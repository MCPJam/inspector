import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_OAUTH_FLOW_STATE, type OAuthFlowState } from "@mcpjam/sdk/browser";
import { createInspectorOAuthStateMachine } from "../debug-state-machine-adapter";

vi.mock("@/lib/session-token", () => ({
  authFetch: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: false,
}));

const EXPECTED_LOGO_URI = "https://www.mcpjam.com/mcp_jam_2row.png";
const REGISTRATION_ENDPOINT = "https://auth.example.com/register";

type FlowCase = {
  protocolVersion: "2025-03-26" | "2025-06-18" | "2025-11-25";
  expectedClientName: string;
};

function createStateMachineHarness({
  protocolVersion,
}: Pick<FlowCase, "protocolVersion">) {
  let state: OAuthFlowState = {
    ...EMPTY_OAUTH_FLOW_STATE,
    currentStep: "received_authorization_server_metadata",
    authorizationServerMetadata: {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      registration_endpoint: REGISTRATION_ENDPOINT,
      response_types_supported: ["code"],
      scopes_supported: ["read", "write"],
    },
    httpHistory: [],
    infoLogs: [],
  };

  const updateState = (updates: Partial<OAuthFlowState>) => {
    state = { ...state, ...updates };
  };

  const machine = createInspectorOAuthStateMachine({
    protocolVersion,
    state,
    getState: () => state,
    updateState,
    serverUrl: "https://mcp.example.com",
    serverName: "Test Server",
    registrationStrategy: "dcr",
  });

  return {
    machine,
    getState: () => state,
  };
}

describe("Inspector OAuth adapter client metadata defaults", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each<FlowCase>([
    {
      protocolVersion: "2025-03-26",
      expectedClientName: "MCP Inspector Debug Client",
    },
    {
      protocolVersion: "2025-06-18",
      expectedClientName: "MCPJam Inspector Debug Client",
    },
    {
      protocolVersion: "2025-11-25",
      expectedClientName: "MCPJam Inspector Debug Client",
    },
  ])(
    "$protocolVersion includes the Inspector logo_uri and client_name in the DCR registration payload",
    async (flowCase) => {
      vi.useFakeTimers();
      const redirectUri = `${window.location.origin}/oauth/callback/debug`;

      const { machine, getState } = createStateMachineHarness(flowCase);

      await machine.proceedToNextStep();

      expect(getState().currentStep).toBe("request_client_registration");
      expect(getState().lastRequest).toMatchObject({
        method: "POST",
        url: REGISTRATION_ENDPOINT,
        body: {
          client_name: flowCase.expectedClientName,
          logo_uri: EXPECTED_LOGO_URI,
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: "read write",
        },
      });
    },
  );
});
