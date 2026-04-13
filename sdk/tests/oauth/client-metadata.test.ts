import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";

const EXPECTED_LOGO_URI = "https://www.mcpjam.com/mcp_jam_2row.png";
const REDIRECT_URI = "https://app.mcpjam.com/oauth/callback/debug";
const REGISTRATION_ENDPOINT = "https://auth.example.com/register";

const CASES = [
  {
    protocolVersion: "2025-03-26" as const,
    expectedClientName: "Injected 2025-03-26 Client",
  },
  {
    protocolVersion: "2025-06-18" as const,
    expectedClientName: "Injected 2025-06-18 Client",
  },
  {
    protocolVersion: "2025-11-25" as const,
    expectedClientName: "Injected 2025-11-25 Client",
  },
];

describe("OAuth state machines use injected dynamic registration metadata", () => {
  it.each(CASES)(
    "$protocolVersion uses the injected client metadata verbatim",
    async ({ protocolVersion, expectedClientName }) => {
      let state = {
        ...EMPTY_OAUTH_FLOW_STATE,
        currentStep: "received_authorization_server_metadata" as const,
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

      const machine = createOAuthStateMachine({
        protocolVersion,
        registrationStrategy: "dcr",
        state,
        getState: () => state,
        updateState: (updates) => {
          state = { ...state, ...updates };
        },
        serverUrl: "https://mcp.example.com/mcp",
        serverName: "Test Server",
        redirectUrl: REDIRECT_URI,
        requestExecutor: jest.fn(async () => {
          throw new Error("requestExecutor should not be called in this test");
        }),
        dynamicRegistration: {
          client_name: expectedClientName,
          client_uri: "https://example.com/client",
          logo_uri: EXPECTED_LOGO_URI,
        },
      });

      await machine.proceedToNextStep();

      expect(state.currentStep).toBe("request_client_registration");
      expect(state.lastRequest).toMatchObject({
        method: "POST",
        url: REGISTRATION_ENDPOINT,
        body: {
          client_name: expectedClientName,
          client_uri: "https://example.com/client",
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

  it.each([
    {
      clientIdMetadataUrl: "http://example.com/client-metadata.json",
      expectedMessage: "Client ID metadata URL must be an absolute HTTPS URL",
    },
    {
      clientIdMetadataUrl: "/client-metadata.json",
      expectedMessage: "Client ID metadata URL must be a valid absolute URL",
    },
  ])(
    "rejects invalid custom CIMD metadata URLs: $clientIdMetadataUrl",
    ({ clientIdMetadataUrl, expectedMessage }) => {
      let state = {
        ...EMPTY_OAUTH_FLOW_STATE,
        httpHistory: [],
        infoLogs: [],
      };

      expect(() =>
        createOAuthStateMachine({
          protocolVersion: "2025-11-25",
          registrationStrategy: "cimd",
          state,
          getState: () => state,
          updateState: (updates) => {
            state = { ...state, ...updates };
          },
          serverUrl: "https://mcp.example.com/mcp",
          serverName: "Test Server",
          redirectUrl: REDIRECT_URI,
          requestExecutor: jest.fn(async () => {
            throw new Error(
              "requestExecutor should not be called in this test",
            );
          }),
          clientIdMetadataUrl,
        }),
      ).toThrow(expectedMessage);
    },
  );
});
