import { describe, it, expect } from "vitest";

import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import {
  toXaaConnectFailure,
  xaaMintCapturePolicy,
} from "../xaa-connect-error.js";
import { XaaConnectFailureReason } from "../../../shared/xaa-connect-failure.js";

const target = {
  serverId: "srv-1",
  serverName: "Billing MCP",
  serverUrl: "https://billing.example.com/mcp",
};

describe("toXaaConnectFailure", () => {
  it("turns a stale-session 401 into a named, re-runnable re-auth ask", () => {
    const framed = toXaaConnectFailure(
      new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        "Missing or invalid bearer token"
      ),
      target
    );

    expect(framed.setupFailureSource).toBe("xaa_mint");
    expect(framed.status).toBe(401);
    expect(framed.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(framed.details).toMatchObject({
      reason: XaaConnectFailureReason.REAUTH_REQUIRED,
      serverId: "srv-1",
      serverName: "Billing MCP",
      xaaReauthRequired: true,
    });
    expect(framed.message).toContain("Billing MCP");
    expect(framed.message).toContain("sign in again");
    // ONE sentence — a swarm banner renders it as-is.
    expect(framed.message.split(/(?<=\.)\s/)).toHaveLength(1);
  });

  it("treats a 403 (confidential CIMD needs a signed-in member) the same way", () => {
    const framed = toXaaConnectFailure(
      new WebRouteError(
        403,
        ErrorCode.FORBIDDEN,
        "Confidential CIMD requires a signed-in organization member"
      ),
      target
    );

    expect(framed.setupFailureSource).toBe("xaa_mint");
    expect(framed.status).toBe(401);
    expect(framed.details).toMatchObject({
      reason: XaaConnectFailureReason.REAUTH_REQUIRED,
    });
  });

  it("keeps a saved-secret refusal actionable instead of asking for a re-auth", () => {
    const refused = new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "Stored credentials were saved for https://owner.example.com; re-enter them for the new address.",
      {
        secretOriginMismatch: true,
        boundOrigin: "https://owner.example.com",
        targetOrigin: "https://moved.example.com",
      },
    );

    const framed = toXaaConnectFailure(refused, {
      serverId: "srv-1",
      serverName: "Docs",
    });

    expect(framed.status).toBe(403);
    expect(framed.details).toMatchObject({
      secretOriginMismatch: true,
      boundOrigin: "https://owner.example.com",
      targetOrigin: "https://moved.example.com",
      reason: XaaConnectFailureReason.CONFIGURATION_INVALID,
    });
    expect(framed.details?.xaaReauthRequired).toBeUndefined();
    expect(framed.message).toContain("re-enter them for the new address");
  });

  it("keeps an export-policy refusal distinct from a re-auth", () => {
    const framed = toXaaConnectFailure(
      new WebRouteError(403, ErrorCode.FORBIDDEN, "Export policy is deny.", {
        exportDenied: true,
        policy: "credentialExportPolicy",
      }),
      { serverId: "srv-1", serverName: "Docs" },
    );
    expect(framed.details).toMatchObject({
      exportDenied: true,
      policy: "credentialExportPolicy",
    });
    expect(framed.details?.xaaReauthRequired).toBeUndefined();
  });

  it("replaces the debugger's 'Configure Server to Test' discovery wording", () => {
    const framed = toXaaConnectFailure(
      new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Couldn't discover an authorization server. Set the issuer in Configure Server to Test."
      ),
      target
    );

    expect(framed.details).toMatchObject({
      reason: XaaConnectFailureReason.AUTHORIZATION_SERVER_UNKNOWN,
    });
    expect(framed.message).toContain("Billing MCP");
    // The debugger's surface is not the surface this user is on.
    expect(framed.message).not.toContain("Configure Server to Test");
    expect(framed.message).toContain("auth settings");
  });

  it("keeps an unsupported-mode reason as a clause under the server's name", () => {
    const framed = toXaaConnectFailure(
      new WebRouteError(
        409,
        ErrorCode.FEATURE_NOT_SUPPORTED,
        "XAA DCR is not available on this Inspector instance"
      ),
      target
    );

    expect(framed.status).toBe(409);
    expect(framed.details).toMatchObject({
      reason: XaaConnectFailureReason.NOT_SUPPORTED_HERE,
    });
    expect(framed.message).toBe(
      'Server "Billing MCP" can\'t use its configured enterprise authorization mode here: XAA DCR is not available on this Inspector instance.'
    );
  });

  it("summarizes a token-exchange rejection without the token endpoint URL", () => {
    const framed = toXaaConnectFailure(
      new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        "XAA token exchange (jwt-bearer grant) was rejected by the authorization server at https://as.example.com/oauth/token (HTTP 401) — invalid_client: unknown client"
      ),
      target
    );

    expect(framed.details).toMatchObject({
      reason: XaaConnectFailureReason.AUTHORIZATION_REJECTED,
    });
    expect(framed.message).toContain("Billing MCP");
    expect(framed.message).toBe(
      'The authorization server for "Billing MCP" rejected MCPJam\'s access request (HTTP 401, invalid_client: unknown client). Check the server\'s auth settings.'
    );
    expect(framed.message).not.toContain("https://");
  });

  it("words a throttled token request the same way, with no em dash or registration-specific advice", () => {
    const framed = toXaaConnectFailure(
      new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        "XAA token exchange (jwt-bearer grant) was rejected by the authorization server at https://as.example.com/oauth/token (HTTP 429)",
        { status: 429 }
      ),
      target
    );

    expect(framed.details).toMatchObject({
      reason: XaaConnectFailureReason.AUTHORIZATION_REJECTED,
    });
    expect(framed.message).toBe(
      'The authorization server for "Billing MCP" rejected MCPJam\'s access request (HTTP 429). Check the server\'s auth settings.'
    );
    expect(framed.details).toMatchObject({ authorizationServerStatus: 429 });
    expect(framed.message).not.toContain("—");
    expect(framed.message).not.toMatch(/client credentials|issuer/);
  });

  it("frames an unclassifiable failure instead of leaking it raw", () => {
    const framed = toXaaConnectFailure(new TypeError("cannot read x of null"), {
      serverId: "srv-1",
      serverName: "Billing MCP",
    });

    expect(framed.status).toBe(500);
    expect(framed.details).toMatchObject({
      reason: XaaConnectFailureReason.HANDSHAKE_FAILED,
    });
    expect(framed.message).toContain("Billing MCP");
    expect(framed.message).not.toContain("cannot read x of null");
    // Nothing is lost: the original still reaches Sentry/Axiom as the cause.
    expect(framed.cause).toBeInstanceOf(TypeError);
  });
});

describe("xaaMintCapturePolicy", () => {
  // The AS answered the jwt-bearer grant with a refusal: the customer's
  // authorization server or their server configuration, never MCPJam. It
  // still reaches Sentry, tagged so the generic paging rule skips it and so
  // triage can read the RFC 6749 code without the (scrubbed) message.
  it("tags an authorization-server rejection as routine with the AS status and error code", () => {
    const policy = xaaMintCapturePolicy(
      new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        "XAA token exchange (jwt-bearer grant) was rejected by the authorization server at https://as.example.com/token (HTTP 400) — invalid_client: unknown client",
        {
          status: 400,
          authorizationServer: "rejected",
          oauthError: "invalid_client",
        }
      )
    );

    expect(policy).toEqual({
      always: true,
      level: "warning",
      tags: {
        page_class: "routine",
        xaa_failure: "authorization_rejected",
        xaa_as_status: "400",
        xaa_as_error: "invalid_client",
      },
    });
  });

  it("omits the error code tag when the AS sent no RFC 6749 error", () => {
    const policy = xaaMintCapturePolicy(
      new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        "XAA token exchange (jwt-bearer grant) was rejected by the authorization server at https://as.example.com/token (HTTP 503)",
        { status: 503, authorizationServer: "rejected" }
      )
    );

    expect(policy?.tags).toEqual({
      page_class: "routine",
      xaa_failure: "authorization_rejected",
      xaa_as_status: "503",
    });
  });

  it("tags a failed authorization-server discovery as routine", () => {
    const policy = xaaMintCapturePolicy(
      new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "Couldn't discover an authorization server. Set the issuer in Configure Server to Test.",
        { authorizationServer: "undiscovered" }
      )
    );

    expect(policy).toEqual({
      always: true,
      level: "warning",
      tags: {
        page_class: "routine",
        xaa_failure: "authorization_server_unknown",
      },
    });
  });

  // The secret-reveal leg maps a backend 404/502 onto the same NOT_FOUND and
  // SERVER_UNREACHABLE codes the refusals use, and may carry a status in
  // `details` too. Only the mint's own `authorizationServer` marker counts;
  // everything else is MCPJam's and keeps the default capture policy.
  it("leaves every other mint failure to the default policy", () => {
    const notARefusal = [
      new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "The server secrets service request failed (404)"
      ),
      new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        "Failed to reach the server secrets service: fetch failed",
        { status: 502 }
      ),
      new WebRouteError(
        502,
        ErrorCode.SERVER_UNREACHABLE,
        "The authorization server at https://as.example.com/token accepted the grant (HTTP 200) but returned no access_token."
      ),
      new WebRouteError(
        401,
        ErrorCode.UNAUTHORIZED,
        "Missing or invalid bearer token"
      ),
      new Error("signing key unavailable"),
      null,
    ];
    for (const error of notARefusal) {
      expect(xaaMintCapturePolicy(error)).toBeUndefined();
    }
  });
});
