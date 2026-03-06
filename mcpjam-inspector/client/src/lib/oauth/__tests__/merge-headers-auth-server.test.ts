/**
 * Integration tests for mergeHeaders Authorization stripping
 *
 * Verifies that Authorization: Bearer headers (intended for the MCP server)
 * are stripped from requests going to the Authorization Server, but kept
 * for requests going to the MCP server.
 *
 * See: RFC 6750 — Bearer tokens are for "protected resources hosted by the
 * resource server", not for Authorization Server endpoints.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OAuthFlowState } from "../state-machines/types";
import { EMPTY_OAUTH_FLOW_STATE } from "../state-machines/types";

// Track all proxyFetch calls so we can inspect headers
let proxyFetchCalls: Array<{ url: string; options: RequestInit }> = [];

// Mock the helpers module to intercept proxyFetch
vi.mock("../state-machines/shared/helpers", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../state-machines/shared/helpers")>();
  return {
    ...actual,
    proxyFetch: vi.fn(async (url: string, options: RequestInit = {}) => {
      proxyFetchCalls.push({ url, options });

      // Return 401 with WWW-Authenticate for MCP server requests
      if (
        url.includes("mcp-server.example.com") &&
        !url.includes(".well-known")
      ) {
        return {
          status: 401,
          statusText: "Unauthorized",
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://mcp-server.example.com/.well-known/oauth-protected-resource"',
          },
          body: null,
          ok: false,
        };
      }

      // Return resource metadata for /.well-known/oauth-protected-resource
      if (url.includes("oauth-protected-resource")) {
        return {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: {
            resource: "https://mcp-server.example.com",
            authorization_servers: ["https://auth-server.example.com"],
          },
          ok: true,
        };
      }

      // Return auth server metadata
      if (
        url.includes("oauth-authorization-server") ||
        url.includes("openid-configuration")
      ) {
        return {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: {
            issuer: "https://auth-server.example.com",
            authorization_endpoint: "https://auth-server.example.com/authorize",
            token_endpoint: "https://auth-server.example.com/token",
            registration_endpoint: "https://auth-server.example.com/register",
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          },
          ok: true,
        };
      }

      // Return success for client registration
      if (url.includes("/register")) {
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

      // Return success for token exchange
      if (url.includes("/token")) {
        return {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: {
            access_token: "new-access-token",
            token_type: "Bearer",
            expires_in: 3600,
          },
          ok: true,
        };
      }

      // Default 404
      return {
        status: 404,
        statusText: "Not Found",
        headers: {},
        body: null,
        ok: false,
      };
    }),
    generateRandomString: vi.fn(() => "mock-random-string"),
    generateCodeChallenge: vi.fn(async () => "mock-code-challenge"),
    loadPreregisteredCredentials: vi.fn(() => ({
      clientId: undefined,
      clientSecret: undefined,
    })),
  };
});

// Mock the MCP SDK's discoverOAuthProtectedResourceMetadata
// This SDK function is called during resource metadata discovery.
// It receives a loggingFetch wrapper, but we mock the whole function
// to return valid metadata directly.
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  discoverOAuthProtectedResourceMetadata: vi.fn(async () => ({
    resource: "https://mcp-server.example.com",
    authorization_servers: ["https://auth-server.example.com"],
  })),
}));

// Import after mocks are set up
import { createDebugOAuthStateMachine } from "../state-machines/debug-oauth-2025-11-25";

// Helper: create a state machine with custom headers and track state updates
function createTestMachine(customHeaders: Record<string, string>) {
  let state: OAuthFlowState = { ...EMPTY_OAUTH_FLOW_STATE };

  const machine = createDebugOAuthStateMachine({
    state,
    getState: () => state,
    updateState: (updates) => {
      state = { ...state, ...updates };
    },
    serverUrl: "https://mcp-server.example.com",
    serverName: "test-server",
    redirectUrl: "http://localhost:3000/oauth/callback/debug",
    customHeaders,
    registrationStrategy: "dcr",
  });

  return { machine, getState: () => state };
}

// Helper: step the machine until it reaches the target step or times out
async function stepUntil(
  machine: { proceedToNextStep: () => Promise<void> },
  getState: () => OAuthFlowState,
  targetStep: string,
  maxSteps = 20,
) {
  for (let i = 0; i < maxSteps; i++) {
    if (getState().currentStep === targetStep) return;
    await machine.proceedToNextStep();
    // Flush any scheduled auto-proceed timeouts
    await vi.advanceTimersByTimeAsync(100);
  }
  throw new Error(
    `Did not reach step "${targetStep}" after ${maxSteps} steps. Current: "${getState().currentStep}"`,
  );
}

// Helper: find proxyFetch calls to a specific URL pattern
function findCallsTo(pattern: string) {
  return proxyFetchCalls.filter((c) => c.url.includes(pattern));
}

// Helper: get headers from a proxyFetch call
function getHeaders(call: { url: string; options: RequestInit }) {
  return (call.options.headers as Record<string, string>) || {};
}

describe("mergeHeaders: Authorization header stripping for auth server requests", () => {
  beforeEach(() => {
    proxyFetchCalls = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("strips Authorization from auth server metadata discovery requests", async () => {
    const { machine, getState } = createTestMachine({
      Authorization: "Bearer leaked-token",
    });

    await stepUntil(
      machine,
      getState,
      "received_authorization_server_metadata",
    );

    const authServerCalls = findCallsTo("oauth-authorization-server");
    expect(authServerCalls.length).toBeGreaterThan(0);

    for (const call of authServerCalls) {
      const headers = getHeaders(call);
      expect(headers).not.toHaveProperty("Authorization");
      expect(headers).not.toHaveProperty("authorization");
    }
  });

  it("strips Authorization from client registration requests", async () => {
    const { machine, getState } = createTestMachine({
      Authorization: "Bearer leaked-token",
    });

    await stepUntil(machine, getState, "received_client_credentials");

    const registrationCalls = findCallsTo("/register");
    expect(registrationCalls.length).toBeGreaterThan(0);

    for (const call of registrationCalls) {
      const headers = getHeaders(call);
      expect(headers).not.toHaveProperty("Authorization");
      expect(headers).not.toHaveProperty("authorization");
    }
  });

  it("strips Authorization from token exchange requests", async () => {
    const { machine, getState } = createTestMachine({
      Authorization: "Bearer leaked-token",
    });

    // Step to authorization_request where flow pauses for user browser auth
    await stepUntil(machine, getState, "authorization_request");

    // Simulate user completing browser authorization
    const currentState = getState();
    Object.assign(currentState, {
      currentStep: "received_authorization_code",
      authorizationCode: "mock-auth-code",
    });

    // Clear calls to isolate the token exchange
    proxyFetchCalls = [];

    await stepUntil(machine, getState, "received_access_token");

    const tokenCalls = findCallsTo("/token");
    expect(tokenCalls.length).toBeGreaterThan(0);

    for (const call of tokenCalls) {
      const headers = getHeaders(call);
      expect(headers).not.toHaveProperty("Authorization");
      expect(headers).not.toHaveProperty("authorization");
    }
  });

  it("keeps Authorization header on MCP server requests", async () => {
    const { machine, getState } = createTestMachine({
      Authorization: "Bearer leaked-token",
    });

    await stepUntil(machine, getState, "received_401_unauthorized");

    // Find the initial MCP server request (not .well-known)
    const mcpCalls = findCallsTo("mcp-server.example.com").filter(
      (c) => !c.url.includes(".well-known"),
    );
    expect(mcpCalls.length).toBeGreaterThan(0);

    for (const call of mcpCalls) {
      const headers = getHeaders(call);
      expect(headers["Authorization"]).toBe("Bearer leaked-token");
    }
  });

  it("keeps other custom headers on auth server requests while stripping Authorization", async () => {
    const { machine, getState } = createTestMachine({
      Authorization: "Bearer leaked-token",
      "X-Custom-Header": "keep-me",
    });

    await stepUntil(
      machine,
      getState,
      "received_authorization_server_metadata",
    );

    const authServerCalls = findCallsTo("oauth-authorization-server");
    expect(authServerCalls.length).toBeGreaterThan(0);

    for (const call of authServerCalls) {
      const headers = getHeaders(call);
      expect(headers).not.toHaveProperty("Authorization");
      expect(headers).not.toHaveProperty("authorization");
      expect(headers["X-Custom-Header"]).toBe("keep-me");
    }
  });
});
