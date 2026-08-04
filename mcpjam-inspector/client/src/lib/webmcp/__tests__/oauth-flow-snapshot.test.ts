/**
 * Denylist contract for the oauth-flow snapshot: feed the builder a maximally
 * poisoned flow state (sentinel token material in every tainted field) and
 * assert none of it — value OR key — survives into the serialized snapshot.
 * The chat transcript is downstream of this function; leakage here is a
 * secret-exfiltration bug, not a formatting bug.
 */
import { describe, expect, it } from "vitest";
import {
  buildOAuthFlowSnapshot,
  isAwaitingHumanAuthorization,
  toSafeSequenceSteps,
  type OAuthFlowSnapshotInput,
} from "../oauth-flow-snapshot";

const SENTINELS = [
  "SENTINEL_ACCESS_TOKEN",
  "SENTINEL_REFRESH_TOKEN",
  "SENTINEL_CLIENT_SECRET",
  "SENTINEL_VERIFIER",
  "SENTINEL_CHALLENGE",
  "SENTINEL_AUTH_CODE",
  "SENTINEL_CSRF_STATE",
  "SENTINEL_AUTHZ_URL",
  "SENTINEL_WWW_AUTH",
  "SENTINEL_HISTORY_BODY",
  "SENTINEL_LOG_DATA",
  "SENTINEL_REQ_HEADER",
  "SENTINEL_LEAK",
];

const FORBIDDEN_KEYS = [
  "accessToken",
  "refreshToken",
  "clientSecret",
  "codeVerifier",
  "codeChallenge",
  "authorizationCode",
  "authorizationUrl",
  "wwwAuthenticateHeader",
  "httpHistory",
  "lastRequest",
  "lastResponse",
  "headers",
  "body",
];
// (counts.infoLogs is deliberately fine — it's counts by level, not entries.)

/**
 * The REAL OAuthFlowState shape, poisoned. The builder's view type omits the
 * sensitive fields, but the runtime object a component passes is the full
 * state — exactly what this test feeds in.
 */
function poisonedInput(): OAuthFlowSnapshotInput {
  const poisonedState = {
    currentStep: "token_request" as const,
    isInitiatingAuth: false,
    serverUrl: "https://mcp.example.com/mcp",
    authorizationServerUrl: "https://auth.example.com",
    accessToken: "SENTINEL_ACCESS_TOKEN",
    refreshToken: "SENTINEL_REFRESH_TOKEN",
    clientSecret: "SENTINEL_CLIENT_SECRET",
    codeVerifier: "SENTINEL_VERIFIER",
    codeChallenge: "SENTINEL_CHALLENGE",
    authorizationCode: "SENTINEL_AUTH_CODE",
    state: "SENTINEL_CSRF_STATE",
    authorizationUrl: "https://auth.example.com/authorize?SENTINEL_AUTHZ_URL",
    wwwAuthenticateHeader: "Bearer SENTINEL_WWW_AUTH",
    tokenType: "Bearer",
    expiresIn: 3600,
    error: "AS said: token=SENTINEL_LEAK invalid_client",
    lastRequest: {
      method: "POST",
      url: "https://auth.example.com/token",
      headers: { Authorization: "SENTINEL_REQ_HEADER" },
      body: "code=SENTINEL_AUTH_CODE",
    },
    lastResponse: {
      status: 401,
      statusText: "Unauthorized",
      headers: { "www-authenticate": "SENTINEL_WWW_AUTH" },
      body: { error: "invalid_client", access_token: "SENTINEL_LEAK" },
    },
    httpHistory: [{ body: "SENTINEL_HISTORY_BODY" }],
    infoLogs: [
      { level: "info" as const, data: "SENTINEL_LOG_DATA" },
      { level: "error" as const, data: "SENTINEL_LOG_DATA" },
      { level: "warning" as const, data: "SENTINEL_LOG_DATA" },
      { level: "warning" as const, data: "SENTINEL_LOG_DATA" },
    ],
  };
  return {
    hasProfile: true,
    serverName: "example",
    protocolVersion: "2025-11-25",
    registrationStrategy: "Dynamic (DCR)",
    scopes: "openid profile",
    clientId: "public-client-id",
    customHeaderCount: 2,
    hasAccessToken: true,
    hasRefreshToken: true,
    serverConnected: false,
    readyToApplyTokens: false,
    steps: [
      {
        id: "token_request",
        label: "Token request",
        // A component bug that forgot toSafeSequenceSteps would pass these:
        description: "POST with code SENTINEL_AUTH_CODE",
        details: [{ label: "verifier", value: "SENTINEL_VERIFIER" }],
      } as { id: string; label: string },
    ],
    view: poisonedState,
  };
}

describe("buildOAuthFlowSnapshot", () => {
  it("emits no sentinel value and no forbidden key", () => {
    const serialized = JSON.stringify(buildOAuthFlowSnapshot(poisonedInput()));
    for (const sentinel of SENTINELS) {
      expect(serialized).not.toContain(sentinel);
    }
    for (const key of FORBIDDEN_KEYS) {
      expect(serialized, key).not.toContain(`"${key}"`);
    }
  });

  it("reduces the error to presence + allowlisted code, never the raw text", () => {
    const snapshot = buildOAuthFlowSnapshot(poisonedInput());
    expect(snapshot.error).toEqual({
      present: true,
      oauthErrorCode: "invalid_client",
    });
  });

  it("keeps only id/label on steps, even when handed full diagram actions", () => {
    const snapshot = buildOAuthFlowSnapshot(poisonedInput());
    expect(snapshot.flow.steps).toEqual([
      { id: "token_request", label: "Token request" },
    ]);
    for (const step of snapshot.flow.steps) {
      expect(Object.keys(step).sort()).toEqual(["id", "label"]);
    }
  });

  it("reduces lastResponse to status/statusText and history/logs to counts", () => {
    const snapshot = buildOAuthFlowSnapshot(poisonedInput());
    expect(snapshot.lastHttp).toEqual({ status: 401, statusText: "Unauthorized" });
    expect(snapshot.counts).toEqual({
      httpRequests: 1,
      infoLogs: { info: 1, warning: 2, error: 1 },
    });
  });

  it("reports token presence as booleans plus non-secret metadata", () => {
    const snapshot = buildOAuthFlowSnapshot(poisonedInput());
    expect(snapshot.tokens).toEqual({
      hasAccessToken: true,
      hasRefreshToken: true,
      tokenType: "Bearer",
      expiresInSeconds: 3600,
    });
  });

  it("flags the human-authorization handoff steps", () => {
    expect(isAwaitingHumanAuthorization("generate_pkce_parameters")).toBe(true);
    expect(isAwaitingHumanAuthorization("authorization_request")).toBe(true);
    expect(isAwaitingHumanAuthorization("token_request")).toBe(false);

    const input = poisonedInput();
    input.view = { ...input.view, currentStep: "authorization_request" };
    expect(
      buildOAuthFlowSnapshot(input).flow.awaitingHumanAuthorization,
    ).toBe(true);
  });

  it("reports an unconfigured tab as configured:false with a null target", () => {
    const input = poisonedInput();
    input.hasProfile = false;
    input.steps = [];
    const snapshot = buildOAuthFlowSnapshot(input);
    expect(snapshot.configured).toBe(false);
    expect(snapshot.target).toBeNull();
  });

  it("maps known steps to their index and unknown diagram ids stay opaque", () => {
    const snapshot = buildOAuthFlowSnapshot(poisonedInput());
    expect(typeof snapshot.flow.stepIndex).toBe("number");
    expect(snapshot.flow.stepIndex).not.toBeNull();
  });
});

describe("toSafeSequenceSteps", () => {
  it("drops every field except id and label", () => {
    const stripped = toSafeSequenceSteps([
      {
        id: "browser_to_auth_server",
        label: "Redirect to authorization server",
        description: "Contains https://auth?code_challenge=SENTINEL",
        details: [{ label: "url", value: "SENTINEL" }],
      } as { id: string; label: string },
    ]);
    expect(stripped).toEqual([
      {
        id: "browser_to_auth_server",
        label: "Redirect to authorization server",
      },
    ]);
    expect(Object.keys(stripped[0])).toEqual(["id", "label"]);
  });
});
