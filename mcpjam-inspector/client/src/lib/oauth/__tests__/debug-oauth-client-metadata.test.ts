import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDebugOAuthStateMachine as createDebugOAuthStateMachine20250326,
  EMPTY_OAUTH_FLOW_STATE_V2 as EMPTY_OAUTH_FLOW_STATE_20250326,
} from "../state-machines/debug-oauth-2025-03-26";
import {
  createDebugOAuthStateMachine as createDebugOAuthStateMachine20250618,
  EMPTY_OAUTH_FLOW_STATE_V2 as EMPTY_OAUTH_FLOW_STATE_20250618,
} from "../state-machines/debug-oauth-2025-06-18";
import {
  createDebugOAuthStateMachine as createDebugOAuthStateMachine20251125,
  EMPTY_OAUTH_FLOW_STATE_V2 as EMPTY_OAUTH_FLOW_STATE_20251125,
} from "../state-machines/debug-oauth-2025-11-25";
import type {
  OAuthFlowState,
  OAuthStateMachine,
} from "../state-machines/types";

const EXPECTED_LOGO_URI = "https://www.mcpjam.com/mcp_jam_2row.png";
const REDIRECT_URI = "https://app.mcpjam.com/oauth/callback/debug";
const REGISTRATION_ENDPOINT = "https://auth.example.com/register";

type MachineFactory = (config: {
  state: OAuthFlowState;
  getState: () => OAuthFlowState;
  updateState: (updates: Partial<OAuthFlowState>) => void;
  serverUrl: string;
  serverName: string;
  redirectUrl: string;
  registrationStrategy: "dcr";
}) => OAuthStateMachine;

type FlowCase = {
  label: string;
  createMachine: MachineFactory;
  emptyState: OAuthFlowState;
  expectedClientName: string;
};

function createStateMachineHarness({
  createMachine,
  emptyState,
}: Pick<FlowCase, "createMachine" | "emptyState">) {
  let state: OAuthFlowState = {
    ...emptyState,
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

  const machine = createMachine({
    state,
    getState: () => state,
    updateState,
    serverUrl: "https://mcp.example.com",
    serverName: "Test Server",
    redirectUrl: REDIRECT_URI,
    registrationStrategy: "dcr",
  });

  return {
    machine,
    getState: () => state,
  };
}

describe("OAuth debugger DCR client metadata", () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each<FlowCase>([
    {
      label: "2025-03-26",
      createMachine: createDebugOAuthStateMachine20250326,
      emptyState: EMPTY_OAUTH_FLOW_STATE_20250326,
      expectedClientName: "MCP Inspector Debug Client",
    },
    {
      label: "2025-06-18",
      createMachine: createDebugOAuthStateMachine20250618,
      emptyState: EMPTY_OAUTH_FLOW_STATE_20250618,
      expectedClientName: "MCPJam Inspector Debug Client",
    },
    {
      label: "2025-11-25",
      createMachine: createDebugOAuthStateMachine20251125,
      emptyState: EMPTY_OAUTH_FLOW_STATE_20251125,
      expectedClientName: "MCPJam Inspector Debug Client",
    },
  ])(
    "%s includes logo_uri in the DCR registration payload",
    async (flowCase) => {
      vi.useFakeTimers();

      const { machine, getState } = createStateMachineHarness(flowCase);

      await machine.proceedToNextStep();

      expect(getState().currentStep).toBe("request_client_registration");
      expect(getState().lastRequest).toMatchObject({
        method: "POST",
        url: REGISTRATION_ENDPOINT,
        body: {
          client_name: flowCase.expectedClientName,
          logo_uri: EXPECTED_LOGO_URI,
          redirect_uris: [REDIRECT_URI],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: "read write",
        },
      });
    },
  );
});
