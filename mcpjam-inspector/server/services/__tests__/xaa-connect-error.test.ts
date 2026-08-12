import { describe, it, expect } from "vitest";

import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";
import { toXaaConnectFailure } from "../xaa-connect-error.js";
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

    expect(framed.status).toBe(401);
    expect(framed.details).toMatchObject({
      reason: XaaConnectFailureReason.REAUTH_REQUIRED,
    });
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
    expect(framed.message).toContain(
      "HTTP 401 — invalid_client: unknown client"
    );
    expect(framed.message).not.toContain("https://");
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
