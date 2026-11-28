import { describe, expect, it } from "vitest";
import type { OAuthFlowState } from "@mcpjam/sdk/browser";
import {
  buildOAuthFlowSummary,
  rememberOAuthFlowSummary,
  takeOAuthFlowSummary,
} from "../flow-summary";

const SECRETS = {
  accessToken: "SECRET_ACCESS_TOKEN",
  refreshToken: "SECRET_REFRESH_TOKEN",
  clientSecret: "SECRET_CLIENT_SECRET",
  codeVerifier: "SECRET_PKCE_VERIFIER",
  state: "SECRET_STATE",
  authorizationCode: "SECRET_AUTH_CODE",
};

const ISSUER = "https://auth.example.test";

function completedState(overrides: Partial<OAuthFlowState> = {}): OAuthFlowState {
  return {
    isInitiatingAuth: false,
    currentStep: "received_access_token",
    authorizationServerMetadata: {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      response_types_supported: ["code"],
    },
    recordedIssuer: ISSUER,
    clientId: "client-123",
    clientSecret: SECRETS.clientSecret,
    tokenEndpointAuthMethod: "client_secret_basic",
    codeVerifier: SECRETS.codeVerifier,
    codeChallenge: "challenge",
    state: SECRETS.state,
    authorizationCode: SECRETS.authorizationCode,
    authorizationUrl: `${ISSUER}/authorize?client_id=client-123&scope=read%20write&resource=https%3A%2F%2Fmcp.example.test%2Fmcp&state=${SECRETS.state}&code_challenge=challenge`,
    requestedScopes: ["read", "write"],
    accessToken: SECRETS.accessToken,
    refreshToken: SECRETS.refreshToken,
    lastResponse: {
      status: 200,
      statusText: "OK",
      headers: {},
      body: {
        access_token: SECRETS.accessToken,
        refresh_token: SECRETS.refreshToken,
        scope: "read",
      },
    },
    ...overrides,
  } as OAuthFlowState;
}

describe("buildOAuthFlowSummary", () => {
  it("reports the flow's facts without any token, secret, verifier, state or code", () => {
    const summary = buildOAuthFlowSummary({
      state: completedState(),
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      callbackIss: ISSUER,
      completedAt: 1_700_000_000_000,
    });

    expect(summary).toEqual({
      completedAt: 1_700_000_000_000,
      issuer: ISSUER,
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      resourceIndicatorSent: true,
      scopesRequested: ["read", "write"],
      scopesGranted: ["read"],
      issReturned: true,
      issValidated: true,
      refreshTokenIssued: true,
      tokenEndpointAuthMethod: "client_secret_basic",
    });
    const serialized = JSON.stringify(summary);
    for (const secret of Object.values(SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain("client-123");
  });

  it("reads requested scopes as granted when the token response names none", () => {
    const summary = buildOAuthFlowSummary({
      state: completedState({
        requestedScopes: undefined,
        refreshToken: undefined,
        lastResponse: {
          status: 200,
          statusText: "OK",
          headers: {},
          body: { access_token: SECRETS.accessToken },
        },
        authorizationUrl: `${ISSUER}/authorize?scope=profile`,
      }),
      callbackIss: null,
    });

    expect(summary).toMatchObject({
      resourceIndicatorSent: false,
      scopesRequested: ["profile"],
      scopesGranted: ["profile"],
      issReturned: false,
      issValidated: false,
      refreshTokenIssued: false,
    });
  });

  it("does not call a returned iss validated when it differs from the recorded issuer", () => {
    const summary = buildOAuthFlowSummary({
      state: completedState(),
      callbackIss: "https://other.example.test",
    });
    expect(summary.issReturned).toBe(true);
    expect(summary.issValidated).toBe(false);
  });
});

describe("pending summaries", () => {
  it("hands a summary to the server's next connect once", () => {
    const summary = buildOAuthFlowSummary({ state: completedState() });
    rememberOAuthFlowSummary("Linear", summary);

    expect(takeOAuthFlowSummary("Other")).toBeUndefined();
    expect(takeOAuthFlowSummary("Linear")).toBe(summary);
    expect(takeOAuthFlowSummary("Linear")).toBeUndefined();
    expect(takeOAuthFlowSummary(undefined)).toBeUndefined();
  });
});
