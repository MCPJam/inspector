import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";

const REDIRECT_URI = "http://127.0.0.1:3333/callback";
const SERVER_URL = "https://mcp.example.com/mcp";
const CHALLENGED_RESOURCE_METADATA_URL =
  "https://mcp.example.com/.well-known/oauth-protected-resource/tenant-a/mcp";

// Spec conformance for the escalation path (MCP authorization spec,
// "Protected Resource Metadata Discovery" + "Scope Selection Strategy"):
// after an unauthenticated probe 401s, the flow MUST use the
// `resource_metadata` URL from the WWW-Authenticate challenge when present,
// and MUST treat the challenged `scope` as authoritative over
// `scopes_supported`. Guards against the escalation silently ignoring the
// challenge the server actually issued.
describe("OAuth escalation conformance to the original WWW-Authenticate challenge", () => {
  it("re-probes unauthenticated and adopts resource_metadata + scope from the 401 challenge (2025-11-25)", async () => {
    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "request_without_token" as const,
      serverUrl: SERVER_URL,
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

    const requestExecutor = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: {
        "www-authenticate": `Bearer resource_metadata="${CHALLENGED_RESOURCE_METADATA_URL}", scope="files:read files:write"`,
      },
      body: null,
    });

    const machine = createOAuthStateMachine({
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor,
      dynamicRegistration: {
        client_name: "Test Client",
      },
    });

    await machine.proceedToNextStep();

    // The probe hit the MCP server itself, without an Authorization header.
    expect(requestExecutor).toHaveBeenCalledTimes(1);
    const probeRequest = requestExecutor.mock.calls[0][0];
    expect(probeRequest.url).toBe(SERVER_URL);
    expect(
      Object.keys(probeRequest.headers ?? {}).map((k) => k.toLowerCase()),
    ).not.toContain("authorization");

    expect(state.currentStep).toBe("received_401_unauthorized");
    expect(state.challengedScopes).toEqual(["files:read", "files:write"]);

    await machine.proceedToNextStep();

    // The challenge's resource_metadata URL is authoritative — no fallback
    // to the path-derived well-known URL.
    expect(state.resourceMetadataUrl).toBe(CHALLENGED_RESOURCE_METADATA_URL);
    expect(state.lastRequest?.url).toBe(CHALLENGED_RESOURCE_METADATA_URL);
  });

  it("prefers the challenged scope over scopes_supported when building the authorization URL (2025-11-25)", async () => {
    let state = {
      ...EMPTY_OAUTH_FLOW_STATE,
      currentStep: "generate_pkce_parameters" as const,
      serverUrl: SERVER_URL,
      challengedScopes: ["files:read", "files:write"],
      resourceMetadata: {
        resource: SERVER_URL,
        scopes_supported: ["everything", "kitchen:sink"],
      },
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        scopes_supported: ["everything"],
      },
      clientId: "client-123",
      codeChallenge: "challenge-abc",
      state: "state-xyz",
      infoLogs: [],
    };

    const machine = createOAuthStateMachine({
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: REDIRECT_URI,
      requestExecutor: jest.fn(),
      dynamicRegistration: {
        client_name: "Test Client",
      },
    });

    await machine.proceedToNextStep();

    expect(state.currentStep).toBe("authorization_request");
    const authUrl = new URL(state.authorizationUrl!);
    expect(authUrl.searchParams.get("scope")).toBe("files:read files:write");
  });
});
