/**
 * The OAuth request executor feeds LIVE data to the state machine. Redaction
 * belongs to the trace layer only.
 *
 * Regression: in hosted mode the executor used to run the token response
 * through `traceOAuthValue`, rewriting `access_token` to
 * `abcd...[redacted]...yz`. That is still a non-empty string, so it passed the
 * `!state.accessToken` guard and went upstream as
 * `Authorization: Bearer abcd...[redacted]...yz`, which resource servers reject
 * with `401 invalid_token`. The trace path must keep redacting; the executor
 * must not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuthFetch,
  mockRunOAuthStateMachine,
  mockDiscoverOAuthServerInfo,
  mockDiscoverAuthorizationServerMetadata,
  mockRegisterClient,
  mockSelectResourceURL,
  mockStartAuthorization,
} = vi.hoisted(() => ({
  mockAuthFetch: vi.fn(),
  mockRunOAuthStateMachine: vi.fn(),
  mockDiscoverOAuthServerInfo: vi.fn(),
  mockDiscoverAuthorizationServerMetadata: vi.fn(),
  mockRegisterClient: vi.fn(),
  mockSelectResourceURL: vi.fn(),
  mockStartAuthorization: vi.fn(),
}));

// Hosted mode is the configuration that exhibited the bug: SANITIZE_OAUTH_TRACES
// is derived from HOSTED_MODE, so locally the redaction is off and this
// regression is invisible.
vi.mock("@/lib/config", async () => {
  const actual = await vi.importActual<typeof import("@/lib/config")>(
    "@/lib/config"
  );
  return { ...actual, HOSTED_MODE: true, SANITIZE_OAUTH_TRACES: true };
});

vi.mock("@/lib/session-token", () => ({ authFetch: mockAuthFetch }));

vi.mock("@mcpjam/sdk/browser", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk/browser")>(
    "@mcpjam/sdk/browser"
  );
  return {
    ...actual,
    runOAuthStateMachine: mockRunOAuthStateMachine,
    discoverOAuthServerInfo: mockDiscoverOAuthServerInfo,
    discoverAuthorizationServerMetadata:
      mockDiscoverAuthorizationServerMetadata,
    registerClient: mockRegisterClient,
    selectResourceURL: mockSelectResourceURL,
    startAuthorization: mockStartAuthorization,
  };
});

const ACCESS_TOKEN = "ntn_supersecretaccesstokenvalue1234567890";
const REFRESH_TOKEN = "rt_supersecretrefreshtokenvalue0987654321";

/** Runs initiateOAuth far enough to capture the executor it builds. */
async function captureRequestExecutor() {
  mockRegisterClient.mockResolvedValue({ client_id: "test-client-id" });
  mockSelectResourceURL.mockResolvedValue(
    new URL("https://mcp.example.com/mcp")
  );
  mockStartAuthorization.mockResolvedValue({
    authorizationUrl: new URL("https://auth.example.com/authorize"),
    codeVerifier: "code-verifier",
  });

  const authorizationServerMetadata = {
    issuer: "https://auth.example.com",
    authorization_endpoint: "https://auth.example.com/authorize",
    token_endpoint: "https://auth.example.com/token",
    registration_endpoint: "https://auth.example.com/register",
  };
  mockDiscoverAuthorizationServerMetadata.mockResolvedValue(
    authorizationServerMetadata
  );
  mockDiscoverOAuthServerInfo.mockResolvedValue({
    authorizationServerUrl: "https://auth.example.com",
    resourceMetadataUrl:
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    resourceMetadata: {
      resource: "https://mcp.example.com/mcp",
      authorization_servers: ["https://auth.example.com"],
    },
    authorizationServerMetadata,
  });

  let requestExecutor: any;
  mockRunOAuthStateMachine.mockImplementation(async (opts: any) => {
    requestExecutor = opts.requestExecutor;
    return { status: "authorization_required", authorizationUrl: "https://x" };
  });

  const { initiateOAuth } = await import("../mcp-oauth");
  await initiateOAuth({
    serverName: "integrity-probe",
    serverUrl: "https://mcp.example.com/mcp",
  } as any);

  expect(requestExecutor, "executor was not captured").toBeTypeOf("function");
  return requestExecutor;
}

describe("OAuth request executor token integrity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("returns the token response verbatim in hosted mode", async () => {
    const requestExecutor = await captureRequestExecutor();

    mockAuthFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: {
            access_token: ACCESS_TOKEN,
            refresh_token: REFRESH_TOKEN,
            token_type: "Bearer",
            expires_in: 3600,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const result = await requestExecutor({
      url: "https://auth.example.com/token",
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { grant_type: "authorization_code", code: "auth-code" },
    });

    const body = result.body as Record<string, unknown>;
    expect(body.access_token).toBe(ACCESS_TOKEN);
    expect(body.refresh_token).toBe(REFRESH_TOKEN);
    expect(String(body.access_token)).not.toContain("[redacted]");
  });

  it("returns registration responses verbatim in hosted mode", async () => {
    const requestExecutor = await captureRequestExecutor();

    mockAuthFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 201,
          statusText: "Created",
          headers: { "content-type": "application/json" },
          body: {
            client_id: "generated-client-id",
            client_secret: "cs_supersecretclientsecretvalue1234567890",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const result = await requestExecutor({
      url: "https://auth.example.com/register",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { client_name: "MCPJam" },
    });

    const body = result.body as Record<string, unknown>;
    expect(body.client_secret).toBe(
      "cs_supersecretclientsecretvalue1234567890"
    );
    expect(String(body.client_secret)).not.toContain("[redacted]");
  });

  // The counterpart invariant: because the executor no longer redacts, the
  // trace layer is the ONLY thing standing between a live token and anything
  // rendered or persisted. Assert it still does its job on a raw body.
  it("still redacts credentials when the trace is projected", async () => {
    const { projectOAuthTraceSnapshot, createOAuthTraceProjectionContext } =
      await vi.importActual<typeof import("@mcpjam/sdk/browser")>(
        "@mcpjam/sdk/browser"
      );

    const snapshot = projectOAuthTraceSnapshot({
      sanitize: true,
      context: createOAuthTraceProjectionContext(),
      state: {
        currentStep: "token_request",
        httpHistory: [
          {
            step: "token_request",
            timestamp: 0,
            request: {
              method: "POST",
              url: "https://auth.example.com/token",
              headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
              body: { grant_type: "authorization_code", code: "auth-code" },
            },
            response: {
              status: 200,
              statusText: "OK",
              headers: { "content-type": "application/json" },
              body: {
                access_token: ACCESS_TOKEN,
                refresh_token: REFRESH_TOKEN,
                token_type: "Bearer",
              },
            },
          },
        ],
        infoLogs: [],
      } as any,
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).toContain("[redacted]");
  });
});
