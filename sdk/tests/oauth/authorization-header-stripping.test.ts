import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import {
  EMPTY_OAUTH_FLOW_STATE,
  type OAuthFlowState,
  type OAuthHttpRequest,
} from "../../src/oauth/state-machines/types.js";

const SERVER_URL = "https://mcp-server.example.com/mcp";
const RESOURCE_METADATA_URL =
  "https://mcp-server.example.com/.well-known/oauth-protected-resource/mcp";
const AUTH_SERVER_URL = "https://auth-server.example.com";

function createStateMachineWithRecorder() {
  let state: OAuthFlowState = {
    ...EMPTY_OAUTH_FLOW_STATE,
    httpHistory: [],
    infoLogs: [],
  };
  const requests: OAuthHttpRequest[] = [];

  const machine = createOAuthStateMachine({
    protocolVersion: "2025-11-25",
    registrationStrategy: "dcr",
    state,
    getState: () => state,
    updateState: (updates) => {
      state = { ...state, ...updates };
    },
    serverUrl: SERVER_URL,
    serverName: "test-server",
    redirectUrl: "http://localhost:3000/oauth/callback/debug",
    customHeaders: {
      Authorization: "Bearer leaked-token",
      "X-Debug": "keep-me",
    },
    requestExecutor: async (request) => {
      requests.push(request);

      if (
        request.url === SERVER_URL &&
        request.headers.Authorization?.startsWith("Bearer access-token")
      ) {
        return {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: {
            jsonrpc: "2.0",
            result: {
              protocolVersion: "2025-11-25",
              serverInfo: { name: "mock", version: "1.0.0" },
              capabilities: {},
            },
          },
          ok: true,
        };
      }

      if (request.url === SERVER_URL) {
        return {
          status: 401,
          statusText: "Unauthorized",
          headers: {
            "www-authenticate": `Bearer resource_metadata="${RESOURCE_METADATA_URL}"`,
          },
          body: null,
          ok: false,
        };
      }

      if (request.url === RESOURCE_METADATA_URL) {
        return {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: {
            resource: SERVER_URL,
            authorization_servers: [AUTH_SERVER_URL],
          },
          ok: true,
        };
      }

      if (
        request.url ===
        `${AUTH_SERVER_URL}/.well-known/oauth-authorization-server`
      ) {
        return {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: {
            issuer: AUTH_SERVER_URL,
            authorization_endpoint: `${AUTH_SERVER_URL}/authorize`,
            token_endpoint: `${AUTH_SERVER_URL}/token`,
            registration_endpoint: `${AUTH_SERVER_URL}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code"],
            code_challenge_methods_supported: ["S256"],
          },
          ok: true,
        };
      }

      if (request.url === `${AUTH_SERVER_URL}/register`) {
        return {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: {
            client_id: "test-client-id",
            client_secret: "test-client-secret",
            token_endpoint_auth_method: "client_secret_post",
          },
          ok: true,
        };
      }

      if (request.url === `${AUTH_SERVER_URL}/token`) {
        return {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: {
            access_token: "access-token",
            token_type: "Bearer",
            expires_in: 3600,
          },
          ok: true,
        };
      }

      return {
        status: 404,
        statusText: "Not Found",
        headers: {},
        body: null,
        ok: false,
      };
    },
    dynamicRegistration: {
      client_name: "SDK Test Client",
    },
    clientIdMetadataUrl: "https://example.com/client-metadata.json",
  });

  return { machine, getState: () => state, requests };
}

async function stepUntil(
  machine: { proceedToNextStep: () => Promise<void> },
  getState: () => OAuthFlowState,
  targetStep: string,
  maxSteps = 20,
) {
  for (let index = 0; index < maxSteps; index += 1) {
    if (getState().currentStep === targetStep) {
      return;
    }

    await machine.proceedToNextStep();
  }

  throw new Error(
    `Did not reach step "${targetStep}". Current step: ${getState().currentStep}`,
  );
}

describe("OAuth state machines strip MCP Authorization headers for auth server requests", () => {
  it("keeps Authorization for same-origin resource metadata and strips it for auth server endpoints", async () => {
    const { machine, getState, requests } = createStateMachineWithRecorder();

    await stepUntil(machine, getState, "authorization_request");

    const resourceMetadataRequest = requests.find(
      (request) => request.url === RESOURCE_METADATA_URL,
    );
    expect(resourceMetadataRequest?.headers.Authorization).toBe(
      "Bearer leaked-token",
    );

    const authServerMetadataRequest = requests.find((request) =>
      request.url.includes("/.well-known/oauth-authorization-server"),
    );
    expect(authServerMetadataRequest?.headers.Authorization).toBeUndefined();

    const registrationRequest = requests.find((request) =>
      request.url.endsWith("/register"),
    );
    expect(registrationRequest?.headers.Authorization).toBeUndefined();
  });

  it("strips Authorization from token requests while preserving the issued bearer token for the MCP probe", async () => {
    const { machine, getState, requests } = createStateMachineWithRecorder();

    await stepUntil(machine, getState, "authorization_request");

    machine.updateState({
      currentStep: "received_authorization_code",
      authorizationCode: "mock-auth-code",
    });

    await stepUntil(machine, getState, "complete");

    const tokenRequest = requests.find((request) => request.url.endsWith("/token"));
    expect(tokenRequest?.headers.Authorization).toBeUndefined();

    const authenticatedProbe = requests.find(
      (request) =>
        request.url === SERVER_URL &&
        request.headers.Authorization === "Bearer access-token",
    );
    expect(authenticatedProbe).toBeDefined();
  });
});
