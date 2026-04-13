import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";

const REDIRECT_URI = "http://127.0.0.1:3333/callback";
const SERVER_URL = "https://mcp.example.com/mcp";
const REGISTRATION_ENDPOINT = "https://auth.example.com/register";

describe("OAuth state machine regressions", () => {
  it("clears stale challengedScopes when optional auth is detected in 2025-06-18", async () => {
    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "request_without_token" as const,
      serverUrl: SERVER_URL,
      challengedScopes: ["stale-scope"],
      httpHistory: [
        {
          step: "request_without_token" as const,
          timestamp: Date.now(),
          request: {
            method: "POST",
            url: SERVER_URL,
            headers: {},
            body: { method: "initialize" },
          },
        },
      ],
      infoLogs: [],
    };

    const machine = createOAuthStateMachine({
      protocolVersion: "2025-06-18",
      registrationStrategy: "dcr",
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor: jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: {},
        body: {
          jsonrpc: "2.0",
          result: {},
        },
      }),
      dynamicRegistration: {
        client_name: "Test Client",
      },
    });

    await machine.proceedToNextStep();

    expect(state.currentStep).toBe("received_401_unauthorized");
    expect(state.challengedScopes).toBeUndefined();
    expect(state.isInitiatingAuth).toBe(false);
  });

  it("clears isInitiatingAuth when strict DCR fails with an HTTP error in 2025-11-25", async () => {
    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "request_client_registration" as const,
      authorizationServerMetadata: {
        registration_endpoint: REGISTRATION_ENDPOINT,
      },
      lastRequest: {
        method: "POST",
        url: REGISTRATION_ENDPOINT,
        headers: {},
        body: { client_name: "Test Client" },
      },
      httpHistory: [
        {
          step: "request_client_registration" as const,
          timestamp: Date.now(),
          request: {
            method: "POST",
            url: REGISTRATION_ENDPOINT,
            headers: {},
            body: { client_name: "Test Client" },
          },
        },
      ],
      infoLogs: [],
      isInitiatingAuth: true,
    };

    const machine = createOAuthStateMachine({
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      strictConformance: true,
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor: jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        headers: {},
        body: {
          error: "invalid_client_metadata",
        },
      }),
      dynamicRegistration: {
        client_name: "Test Client",
      },
    });

    await machine.proceedToNextStep();

    expect(state.error).toBe("Dynamic Client Registration failed (400).");
    expect(state.isInitiatingAuth).toBe(false);
  });

  it("clears isInitiatingAuth when strict DCR fails with a transport error in 2025-11-25", async () => {
    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "request_client_registration" as const,
      authorizationServerMetadata: {
        registration_endpoint: REGISTRATION_ENDPOINT,
      },
      lastRequest: {
        method: "POST",
        url: REGISTRATION_ENDPOINT,
        headers: {},
        body: { client_name: "Test Client" },
      },
      httpHistory: [
        {
          step: "request_client_registration" as const,
          timestamp: Date.now(),
          request: {
            method: "POST",
            url: REGISTRATION_ENDPOINT,
            headers: {},
            body: { client_name: "Test Client" },
          },
        },
      ],
      infoLogs: [],
      isInitiatingAuth: true,
    };

    const machine = createOAuthStateMachine({
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      strictConformance: true,
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor: jest.fn().mockRejectedValue(new Error("boom")),
      dynamicRegistration: {
        client_name: "Test Client",
      },
    });

    await machine.proceedToNextStep();

    expect(state.error).toBe("Client registration failed: boom");
    expect(state.isInitiatingAuth).toBe(false);
  });
});
