/**
 * The completion criterion, stated once as a test.
 *
 * A sanitized trace must contain no raw access token, refresh token, ID token,
 * client secret, authorization code, PKCE verifier, cookie, authorization
 * header, or OAuth `state` — including inside error strings and URLs.
 *
 * Written as one exhaustive sweep rather than nine focused tests on purpose:
 * each individual leak was found in a different place (a fallback branch, a
 * request URL, prose reshaped into fields), and what they had in common was
 * that nobody was asking the whole question at once. This asks it.
 */

import { projectOAuthTraceSnapshot } from "../../src/oauth/state-machines/trace.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";

/** Distinct, unmistakable values — a hit is a leak, never a coincidence. */
const SECRETS = {
  accessToken: "ntn_LEAKED_ACCESS_TOKEN_0000000001",
  refreshToken: "rt_LEAKED_REFRESH_TOKEN_0000000002",
  idToken: "eyJLEAKEDIDTOKEN.eyJwYXlsb2Fk.c2ln0000000003",
  clientSecret: "cs_LEAKED_CLIENT_SECRET_0000000004",
  authorizationCode: "ac_LEAKED_AUTHORIZATION_CODE_00005",
  codeVerifier: "cv_LEAKED_CODE_VERIFIER_0000000006",
  cookie: "session=LEAKED_COOKIE_VALUE_0000000007",
  state: "st_LEAKED_CSRF_STATE_00000000000008",
};

function buildStateWithEverySecret() {
  return {
    ...EMPTY_OAUTH_FLOW_STATE,
    currentStep: "token_request",
    serverUrl: "https://mcp.example.com/mcp",
    accessToken: SECRETS.accessToken,
    refreshToken: SECRETS.refreshToken,
    idToken: SECRETS.idToken,
    clientSecret: SECRETS.clientSecret,
    authorizationCode: SECRETS.authorizationCode,
    codeVerifier: SECRETS.codeVerifier,
    state: SECRETS.state,
    clientId: "client-id",
    tokenType: "Bearer",
    expiresIn: 3600,
    authorizationUrl: `https://auth.example.com/authorize?client_id=x&state=${SECRETS.state}&code_challenge=abc`,
    // Every shape a secret arrives in: a request URL query, request headers, a
    // form body, a response body, a transport error message, error details, and
    // a free-form flow error.
    error:
      `Token request failed: invalid_grant - refresh_token=${SECRETS.refreshToken} ` +
      `and state=${SECRETS.state} were rejected`,
    httpHistory: [
      {
        step: "token_request",
        timestamp: 1_000,
        request: {
          method: "POST",
          url: `https://auth.example.com/token?state=${SECRETS.state}&code=${SECRETS.authorizationCode}`,
          headers: {
            Authorization: `Bearer ${SECRETS.accessToken}`,
            Cookie: SECRETS.cookie,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: {
            grant_type: "authorization_code",
            code: SECRETS.authorizationCode,
            code_verifier: SECRETS.codeVerifier,
            client_secret: SECRETS.clientSecret,
            state: SECRETS.state,
          },
        },
        response: {
          status: 400,
          statusText: "Bad Request",
          headers: { "set-cookie": SECRETS.cookie },
          body: {
            access_token: SECRETS.accessToken,
            refresh_token: SECRETS.refreshToken,
            id_token: SECRETS.idToken,
            error_description: `rejected access_token=${SECRETS.accessToken}`,
          },
        },
        error: {
          message: `upstream said Bearer ${SECRETS.accessToken}`,
          details: { client_secret: SECRETS.clientSecret },
        },
      },
      {
        step: "authorization_request",
        timestamp: 900,
        request: {
          method: "GET",
          url: `https://auth.example.com/authorize?state=${SECRETS.state}`,
          headers: {},
        },
      },
    ],
    infoLogs: [
      {
        step: "token_request",
        timestamp: 950,
        id: "leaky-log",
        label: "Token request prepared",
        data: {
          code_verifier: SECRETS.codeVerifier,
          state: SECRETS.state,
          formBody: `grant_type=authorization_code&code=${SECRETS.authorizationCode}`,
        },
        error: { message: `client_secret=${SECRETS.clientSecret} rejected` },
      },
    ],
  } as never;
}

describe("a sanitized trace contains no raw secret", () => {
  const snapshot = projectOAuthTraceSnapshot({
    sanitize: true,
    state: buildStateWithEverySecret(),
  });
  const serialized = JSON.stringify(snapshot);

  it.each(Object.entries(SECRETS))("does not contain the %s", (_name, value) => {
    expect(serialized).not.toContain(value);
  });

  it("still says enough to debug with", () => {
    // Redaction that produces an empty trace would pass the test above and be
    // useless. The step, the endpoint, and the non-secret parameters survive.
    expect(serialized).toContain("token_request");
    expect(serialized).toContain("auth.example.com/token");
    expect(serialized).toContain("authorization_code");
    expect(serialized).toContain("invalid_grant");
    expect(serialized).toContain("[redacted]");
  });

  it("leaves everything raw when sanitize is false (local dev)", () => {
    const raw = JSON.stringify(
      projectOAuthTraceSnapshot({
        sanitize: false,
        state: buildStateWithEverySecret(),
      }),
    );

    // The inspector's whole purpose locally is to show what actually happened.
    for (const value of Object.values(SECRETS)) {
      expect(raw).toContain(value);
    }
  });
});
