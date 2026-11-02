import { InsufficientScopeError } from "@modelcontextprotocol/client";
import { parseChallengeHeader } from "@mcpjam/sdk";
import { describe, expect, it } from "vitest";
import { authChallengeInfoFromToolError } from "../auth-challenge-chat.js";

const CHALLENGE =
  'Bearer error="invalid_token", error_description="Sign in to read orders", scope="orders:read", resource_metadata="https://orders.example/.well-known/oauth-protected-resource/mcp"';

/** The error the SDK's HTTP error fetch throws for a 401 on `tools/call`. */
function http401(header: string | null = CHALLENGE): Error {
  return Object.assign(new Error("Error POSTing to endpoint (HTTP 401)"), {
    status: 401,
    data: { authChallenge: parseChallengeHeader(header) },
  });
}

describe("authChallengeInfoFromToolError", () => {
  it("recognizes a thrown 401 and stamps the recorded auth method", () => {
    expect(
      authChallengeInfoFromToolError({
        error: http401(),
        serverId: "orders",
        toolCallId: "call-1",
        effectiveAuth: "discover",
      }),
    ).toMatchObject({
      serverId: "orders",
      toolCallId: "call-1",
      signal: {
        source: "http_401",
        requiredScope: "orders:read",
        effectiveAuth: "discover",
      },
    });
  });

  it("recognizes the hosted tokenless connection's 403 envelope", () => {
    const error = Object.assign(new Error("asked for sign-in"), {
      status: 403,
      details: {
        upstreamAuthRequired: true,
        authChallenge: {
          ...parseChallengeHeader(CHALLENGE),
          effectiveAuth: "discover",
        },
      },
    });
    expect(
      authChallengeInfoFromToolError({ error, serverId: "orders" })?.signal,
    ).toMatchObject({ source: "http_401", effectiveAuth: "discover" });
  });

  it("leaves a 403 step-up and ordinary errors alone", () => {
    expect(
      authChallengeInfoFromToolError({
        error: new InsufficientScopeError({ requiredScope: "orders:write" }),
        serverId: "orders",
      }),
    ).toBeUndefined();
    expect(
      authChallengeInfoFromToolError({
        error: new Error("boom"),
        serverId: "orders",
      }),
    ).toBeUndefined();
  });

});
