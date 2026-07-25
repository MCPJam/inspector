import { createOAuthStateMachine } from "../../src/oauth/state-machines/factory.js";
import {
  EMPTY_OAUTH_FLOW_STATE,
  buildResetFlowState,
} from "../../src/oauth/state-machines/types.js";
import type {
  OAuthFlowState,
  OAuthProtocolVersion,
} from "../../src/oauth/state-machines/types.js";

const REDIRECT_URI = "http://127.0.0.1:3333/callback";
const SERVER_URL = "https://mcp.example.com/mcp";
const REGISTRATION_ENDPOINT = "https://auth.example.com/register";

const ALL_VERSIONS: OAuthProtocolVersion[] = [
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
];

// A registration strategy that reaches the DCR path for every version.
const DCR_STRATEGY = "dcr" as const;

function makeMachine(
  protocolVersion: OAuthProtocolVersion,
  seed: Partial<OAuthFlowState>,
  extra: Record<string, unknown> = {},
) {
  let state: OAuthFlowState = {
    ...EMPTY_OAUTH_FLOW_STATE,
    ...seed,
  };
  const machine = createOAuthStateMachine({
    protocolVersion,
    registrationStrategy: DCR_STRATEGY,
    state,
    getState: () => state,
    updateState: (updates) => {
      state = { ...state, ...updates };
    },
    serverUrl: SERVER_URL,
    serverName: "Test Server",
    redirectUrl: REDIRECT_URI,
    requestExecutor: jest.fn(),
    dynamicRegistration: { client_name: "Test Client" },
    ...(extra as any),
  });
  return { machine, getState: () => state };
}

// -----------------------------------------------------------------------------
// Defect 1: resetFlow must fully clear state (updateState MERGES, so a partial
// reset leaves stale credentials/tokens/discovery/recorded issuer behind).
// -----------------------------------------------------------------------------
describe("resetFlow clears all prior flow state", () => {
  // buildResetFlowState is the shared source of truth; verify it names every
  // optional field so future OAuthFlowState growth can't silently leak.
  it("buildResetFlowState clears every optional OAuthFlowState field", () => {
    const reset = buildResetFlowState();
    // Sample the full set of carry-over fields.
    for (const key of [
      "serverUrl",
      "wwwAuthenticateHeader",
      "challengedScopes",
      "resourceMetadataUrl",
      "resourceMetadata",
      "resourceIndicator",
      "authorizationServerUrl",
      "authorizationServerMetadata",
      "clientId",
      "clientSecret",
      "tokenEndpointAuthMethod",
      "codeVerifier",
      "codeChallenge",
      "codeChallengeMethod",
      "authorizationUrl",
      "authorizationCode",
      "state",
      "recordedIssuer",
      "authorizationResponseIss",
      "requestedScopes",
      "accessToken",
      "refreshToken",
      "tokenType",
      "expiresIn",
      "lastRequest",
      "lastResponse",
      "error",
    ] as const) {
      expect(reset).toHaveProperty(key);
      expect((reset as Record<string, unknown>)[key]).toBeUndefined();
    }
    expect(reset.currentStep).toBe("idle");
    expect(reset.isInitiatingAuth).toBe(false);
    expect(reset.httpHistory).toEqual([]);
    expect(reset.infoLogs).toEqual([]);
    // Fresh array instances, not shared references.
    expect(reset.httpHistory).not.toBe(buildResetFlowState().httpHistory);
  });

  it.each(ALL_VERSIONS)(
    "resetFlow wipes stored client, tokens, discovery, and recorded issuer (%s)",
    (version) => {
      const stale: Partial<OAuthFlowState> = {
        currentStep: "complete",
        isInitiatingAuth: true,
        serverUrl: SERVER_URL,
        wwwAuthenticateHeader: 'Bearer realm="x"',
        challengedScopes: ["files:read"],
        resourceMetadataUrl: "https://mcp.example.com/.well-known/x",
        resourceMetadata: { resource: SERVER_URL },
        authorizationServerUrl: "https://auth.example.com",
        authorizationServerMetadata: {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          response_types_supported: ["code"],
        },
        clientId: "stale-client-id",
        clientSecret: "stale-secret",
        tokenEndpointAuthMethod: "client_secret_basic",
        codeVerifier: "stale-verifier",
        codeChallenge: "stale-challenge",
        authorizationUrl: "https://auth.example.com/authorize?x=1",
        authorizationCode: "stale-code",
        state: "stale-state",
        recordedIssuer: "https://auth.example.com",
        authorizationResponseIss: "https://auth.example.com",
        requestedScopes: ["files:read"],
        accessToken: "stale-access-token",
        refreshToken: "stale-refresh-token",
        tokenType: "Bearer",
        expiresIn: 3600,
        lastRequest: {
          method: "POST",
          url: SERVER_URL,
          headers: {},
          body: {},
        },
        lastResponse: {
          status: 200,
          statusText: "OK",
          headers: {},
          body: {},
        },
        httpHistory: [
          {
            step: "complete",
            timestamp: Date.now(),
            request: { method: "GET", url: SERVER_URL, headers: {} },
          },
        ],
        infoLogs: [
          {
            id: "1",
            step: "complete",
            label: "x",
            data: {},
            timestamp: Date.now(),
            level: "info",
          },
        ],
        error: "stale error",
      };

      const { machine, getState } = makeMachine(version, stale);
      machine.resetFlow();
      const s = getState();

      expect(s.currentStep).toBe("idle");
      expect(s.isInitiatingAuth).toBe(false);
      expect(s.httpHistory).toEqual([]);
      expect(s.infoLogs).toEqual([]);

      // None of the stale fields survive the reset.
      expect(s.serverUrl).toBeUndefined();
      expect(s.wwwAuthenticateHeader).toBeUndefined();
      expect(s.challengedScopes).toBeUndefined();
      expect(s.resourceMetadataUrl).toBeUndefined();
      expect(s.resourceMetadata).toBeUndefined();
      expect(s.authorizationServerUrl).toBeUndefined();
      expect(s.authorizationServerMetadata).toBeUndefined();
      expect(s.clientId).toBeUndefined();
      expect(s.clientSecret).toBeUndefined();
      expect(s.tokenEndpointAuthMethod).toBeUndefined();
      expect(s.codeVerifier).toBeUndefined();
      expect(s.codeChallenge).toBeUndefined();
      expect(s.authorizationUrl).toBeUndefined();
      expect(s.authorizationCode).toBeUndefined();
      expect(s.state).toBeUndefined();
      expect(s.recordedIssuer).toBeUndefined();
      expect(s.authorizationResponseIss).toBeUndefined();
      expect(s.requestedScopes).toBeUndefined();
      expect(s.accessToken).toBeUndefined();
      expect(s.refreshToken).toBeUndefined();
      expect(s.tokenType).toBeUndefined();
      expect(s.expiresIn).toBeUndefined();
      expect(s.lastRequest).toBeUndefined();
      expect(s.lastResponse).toBeUndefined();
      expect(s.error).toBeUndefined();
    },
  );
});

// -----------------------------------------------------------------------------
// Defect 2: a 2xx DCR response missing client_id must be rejected even in
// non-strict mode (RFC 7591 requires client_id on a successful registration).
// -----------------------------------------------------------------------------
describe("DCR success without client_id is rejected", () => {
  it.each(ALL_VERSIONS)(
    "rejects a 201 registration response that omits client_id in non-strict mode (%s)",
    async (version) => {
      const seed: Partial<OAuthFlowState> = {
        currentStep: "request_client_registration",
        authorizationServerMetadata: {
          issuer: "https://auth.example.com",
          authorization_endpoint: "https://auth.example.com/authorize",
          token_endpoint: "https://auth.example.com/token",
          registration_endpoint: REGISTRATION_ENDPOINT,
          response_types_supported: ["code"],
        },
        lastRequest: {
          method: "POST",
          url: REGISTRATION_ENDPOINT,
          headers: {},
          body: { client_name: "Test Client" },
        },
        httpHistory: [
          {
            step: "request_client_registration",
            timestamp: Date.now(),
            request: {
              method: "POST",
              url: REGISTRATION_ENDPOINT,
              headers: {},
              body: { client_name: "Test Client" },
            },
          },
        ],
        isInitiatingAuth: true,
      };

      // A 2xx registration response that is a valid JSON object but has NO
      // client_id. strictConformance intentionally left false/omitted.
      const requestExecutor = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        statusText: "Created",
        headers: {},
        body: {
          client_name: "Test Client",
          token_endpoint_auth_method: "none",
          // client_id deliberately absent
        },
      });

      const { machine, getState } = makeMachine(version, seed, {
        requestExecutor,
      });

      await machine.proceedToNextStep();
      const s = getState();

      expect(s.error).toBe(
        "Dynamic Client Registration response is missing a client_id.",
      );
      expect(s.clientId).toBeUndefined();
      expect(s.currentStep).not.toBe("received_client_credentials");
      expect(s.isInitiatingAuth).toBe(false);
    },
  );
});

// -----------------------------------------------------------------------------
// Defect 3: CIMD document must be fetched ONCE and the exact fetched (and
// displayed) document validated — not re-fetched at validation time.
// -----------------------------------------------------------------------------
describe("CIMD document is fetched once and the shown document is validated", () => {
  const CIMD_URL = "https://client.example.com/.well-known/client-metadata.json";

  it.each(["2025-11-25", "2026-07-28"] as OAuthProtocolVersion[])(
    "validates the single fetched document, never a second fetch (%s)",
    async (version) => {
      const goodDoc = {
        client_id: CIMD_URL,
        client_name: "Honest Client",
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
      };
      // A second fetch — if it happened — would return a mismatched document
      // that fails validation, so a passing flow proves only one fetch occurred.
      const swappedDoc = {
        client_id: "https://evil.example.com/metadata.json",
        client_name: "Swapped Client",
      };

      const requestExecutor = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: goodDoc,
        })
        .mockResolvedValue({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: swappedDoc,
        });

      let state: OAuthFlowState = {
        ...EMPTY_OAUTH_FLOW_STATE,
        currentStep: "cimd_fetch_request",
        serverUrl: SERVER_URL,
      };
      const machine = createOAuthStateMachine({
        protocolVersion: version,
        registrationStrategy: "cimd",
        state,
        getState: () => state,
        updateState: (updates) => {
          state = { ...state, ...updates };
        },
        serverUrl: SERVER_URL,
        serverName: "Test Server",
        redirectUrl: REDIRECT_URI,
        requestExecutor,
        clientIdMetadataUrl: CIMD_URL,
        dynamicRegistration: { client_name: "Test Client" },
      });

      // Step 1: fetch the CIMD document.
      await machine.proceedToNextStep();
      expect(state.currentStep).toBe("cimd_metadata_response");
      // The fetched document is recorded as the shown response.
      expect(state.lastResponse?.body).toEqual(goodDoc);

      // The CIMD trace step is timed like every other fetch: its timestamp
      // marks request start (before the fetch) and it carries a round-trip
      // duration, rather than being stamped after the fetch with no duration.
      const cimdEntry = (state.httpHistory ?? []).find(
        (e) => e.step === "cimd_fetch_request",
      );
      expect(cimdEntry).toBeDefined();
      expect(typeof cimdEntry?.timestamp).toBe("number");
      expect(typeof cimdEntry?.duration).toBe("number");
      expect(cimdEntry?.duration).toBeGreaterThanOrEqual(0);

      // Step 2: validate — must NOT issue a second fetch.
      await machine.proceedToNextStep();

      expect(requestExecutor).toHaveBeenCalledTimes(1);
      expect(state.error).toBeUndefined();
      expect(state.currentStep).toBe("received_client_credentials");
      expect(state.clientId).toBe(CIMD_URL);
    },
  );
});

// -----------------------------------------------------------------------------
// Defect 4: the unauthenticated pre-401 probe must carry MCP-Protocol-Version,
// like every other request the machine issues.
// -----------------------------------------------------------------------------
describe("pre-401 probe carries the MCP-Protocol-Version header", () => {
  const PROBE_VERSIONS: Array<[OAuthProtocolVersion, string]> = [
    ["2025-03-26", "2025-03-26"],
    ["2025-06-18", "2025-06-18"],
    ["2025-11-25", "2025-11-25"],
    ["2026-07-28", "2026-07-28"],
  ];

  it.each(PROBE_VERSIONS)(
    "the executed probe request includes MCP-Protocol-Version (%s)",
    async (version, expectedHeaderValue) => {
      const requestExecutor = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { "www-authenticate": "Bearer" },
        body: null,
      });

      const seed: Partial<OAuthFlowState> = {
        currentStep: "request_without_token",
        serverUrl: SERVER_URL,
        httpHistory: [
          {
            step: "request_without_token",
            timestamp: Date.now(),
            request: {
              method: "POST",
              url: SERVER_URL,
              headers: {},
              body: {},
            },
          },
        ],
      };

      const { machine } = makeMachine(version, seed, { requestExecutor });
      await machine.proceedToNextStep();

      expect(requestExecutor).toHaveBeenCalledTimes(1);
      const probe = requestExecutor.mock.calls[0][0];
      const headerEntry = Object.entries(probe.headers ?? {}).find(
        ([k]) => k.toLowerCase() === "mcp-protocol-version",
      );
      expect(headerEntry).toBeDefined();
      expect(headerEntry?.[1]).toBe(expectedHeaderValue);
    },
  );
});
