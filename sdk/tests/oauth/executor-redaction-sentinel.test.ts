/**
 * Defense in depth for the #3865 failure shape.
 *
 * A trace redactor was applied to data the OAuth flow CONSUMES, so the state
 * machine received `access_token: "abcd...[redacted]...yz"` — still a non-empty
 * string, so it passed every truthiness check and went upstream as
 * `Authorization: Bearer abcd...[redacted]...yz`. The resource server's
 * `401 invalid_token` was the first and only signal, three layers away from the
 * cause.
 *
 * The factory already wraps every machine's executor for SSRF, so it is the one
 * place that sees every executor result for all four eras. Inspect the
 * credential fields there and fail loudly at the seam instead of silently
 * shipping a redaction sentinel as a credential.
 *
 * This recognizes the sentinel shapes the codebase currently produces. It is
 * not a proof that every future redactor is covered — keeping trace
 * transformations out of live-data paths is still the actual rule.
 */

import {
  assertOAuthResultCredentialsUnredacted,
  createOAuthStateMachine,
  OAuthRedactedCredentialError,
} from "../../src/oauth/state-machines/factory.js";
import { EMPTY_OAUTH_FLOW_STATE } from "../../src/oauth/state-machines/types.js";
import type {
  OAuthFlowState,
  OAuthRequestResult,
} from "../../src/oauth/state-machines/types.js";

const REQUEST = {
  method: "POST",
  url: "https://auth.example.com/token?client_id=abc#frag",
  headers: {},
};

/** The real executor's shape — credentials live under `body`, not on the result. */
function result(body: unknown): OAuthRequestResult {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {},
    body,
  } as OAuthRequestResult;
}

describe("executor redaction sentinel", () => {
  it("throws on the truncated-tail sentinel in access_token", () => {
    expect(() =>
      assertOAuthResultCredentialsUnredacted(
        result({
          access_token: "abcd...[redacted]...yz",
          token_type: "Bearer",
        }),
        REQUEST,
      ),
    ).toThrow(OAuthRedactedCredentialError);
  });

  it("names the offending field and a query/fragment-free target", () => {
    let thrown: unknown;
    try {
      assertOAuthResultCredentialsUnredacted(
        result({ access_token: "abcd...[redacted]...yz" }),
        REQUEST,
      );
    } catch (error) {
      thrown = error;
    }

    const message = (thrown as Error).message;
    expect(message).toContain("access_token");
    expect(message).toContain("https://auth.example.com/token");
    // The target is for diagnosis, not for echoing back request parameters.
    expect(message).not.toContain("client_id=abc");
    expect(message).not.toContain("frag");
  });

  it.each([
    ["refresh_token", "wxyz...[redacted]...ab"],
    ["id_token", "[redacted]"],
    ["client_secret", "[redacted]"],
  ])("throws on a redacted %s", (field, value) => {
    expect(() =>
      assertOAuthResultCredentialsUnredacted(
        result({ [field]: value }),
        REQUEST,
      ),
    ).toThrow(OAuthRedactedCredentialError);
  });

  it("returns a clean result by identity", () => {
    const clean = result({
      access_token: "ntn_realaccesstokenvalue1234567890",
      refresh_token: "rt_realrefreshtokenvalue0987654321",
      token_type: "Bearer",
      expires_in: 3600,
    });
    expect(assertOAuthResultCredentialsUnredacted(clean, REQUEST)).toBe(clean);
  });

  it("ignores non-object and non-string bodies", () => {
    for (const body of [
      undefined,
      null,
      "raw text",
      42,
      [{ access_token: "abcd...[redacted]...yz" }],
    ]) {
      const value = result(body);
      expect(assertOAuthResultCredentialsUnredacted(value, REQUEST)).toBe(value);
    }
  });

  // A credential that merely mentions the word must not trip the guard —
  // opaque tokens are arbitrary strings and a false positive breaks a real
  // login.
  it("does not fire on a credential that merely contains the word", () => {
    for (const token of [
      "this-token-is-not-redacted-but-mentions-redacted",
      "redacted",
      "abcd...[REDACTION]...yz",
    ]) {
      const value = result({ access_token: token });
      expect(assertOAuthResultCredentialsUnredacted(value, REQUEST)).toBe(value);
    }
  });
});

describe("factory wraps every machine's executor with the redaction sentinel", () => {
  const SERVER_URL = "https://mcp.example.com/mcp";

  function buildAtRegistration(registrationBody: unknown) {
    const inner = vi.fn().mockResolvedValue(result(registrationBody));
    let state: OAuthFlowState = {
      ...EMPTY_OAUTH_FLOW_STATE,
      serverUrl: SERVER_URL,
      currentStep: "received_authorization_server_metadata",
      authorizationServerMetadata: {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      },
    };
    const machine = createOAuthStateMachine({
      protocolVersion: "2026-07-28",
      registrationStrategy: "dcr",
      state,
      getState: () => state,
      updateState: (updates) => {
        state = { ...state, ...updates };
      },
      serverUrl: SERVER_URL,
      serverName: "Test Server",
      redirectUrl: "http://127.0.0.1:3333/callback",
      requestExecutor: inner,
      dynamicRegistration: { client_name: "Test Client" },
    });
    return { machine, inner, getState: () => state };
  }

  const advance = async (machine: { proceedToNextStep: () => Promise<void> }) => {
    for (let i = 0; i < 3; i++) {
      await machine.proceedToNextStep().catch(() => {});
    }
  };

  it("surfaces a redacted registration secret as a flow error", async () => {
    const { machine, getState } = buildAtRegistration({
      client_id: "generated",
      client_secret: "abcd...[redacted]...yz",
    });
    await advance(machine);

    expect(getState().error ?? "").toContain("client_secret");
  });

  it("leaves a clean registration response alone", async () => {
    const { machine, getState } = buildAtRegistration({
      client_id: "generated",
      client_secret: "cs_realclientsecretvalue1234567890",
    });
    await advance(machine);

    expect(getState().clientId).toBe("generated");
    expect(getState().error ?? "").not.toContain("redact");
  });
});
