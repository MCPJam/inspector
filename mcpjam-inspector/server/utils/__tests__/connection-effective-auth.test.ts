/**
 * Mid-session sign-in challenges on the server: the effective-auth stamp, the
 * envelope on a completed result, and how every route family reports a
 * challenge (local `mcpError.authChallenge`, hosted 403 UPSTREAM_AUTH_FAILED,
 * v1 AUTH_REQUIRED), reduced where the hosted rules require.
 */

import { describe, expect, it } from "vitest";
import { InsufficientScopeError, SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { parseChallengeHeader } from "@mcpjam/sdk";

import {
  connectionEffectiveAuth,
  readAuthChallenge,
  recordConnectionEffectiveAuth,
  stampAuthChallenge,
  stampErrorAuthChallenge,
  toolResultAuthChallengeEnvelope,
  withStampedAuthChallenge,
} from "../connection-effective-auth.js";
import { jsonError, serializeMcpError } from "../mcp-error-serialize.js";
import { mapRuntimeError } from "../../routes/web/errors.js";
import { mapErrorToV1 } from "../../routes/v1/envelope.js";
import { projectAuthChallenge } from "../hosted-upstream-projection.js";
import { projectHostedAuthoredFailureDetails } from "../hosted-route-failure.js";

const PRM = "https://orders.example.com/.well-known/oauth-protected-resource/mcp";
const HEADER = `Bearer error="invalid_token", error_description="Sign in to see your orders", resource_metadata="${PRM}", scope="orders:read"`;

function http401(header: string | undefined = HEADER) {
  return new SdkHttpError(
    SdkErrorCode.ClientHttpAuthentication,
    `Error POSTing to endpoint (HTTP 401): {}`,
    { status: 401, authChallenge: parseChallengeHeader(header) },
  );
}

const META_RESULT = {
  isError: true,
  content: [{ type: "text", text: "Sign in" }],
  _meta: {
    "mcp/www_authenticate": [
      `Bearer resource_metadata="${PRM}", error="insufficient_scope", error_description="You need to login to continue"`,
    ],
  },
};

describe("the connection registry", () => {
  it("records per manager and per server, and forgets nothing it was not told", () => {
    const manager = {};
    const other = {};
    recordConnectionEffectiveAuth(manager, "orders", "discover");
    recordConnectionEffectiveAuth(manager, "billing", "xaa");
    expect(connectionEffectiveAuth(manager, "orders")).toBe("discover");
    expect(connectionEffectiveAuth(manager, "billing")).toBe("xaa");
    expect(connectionEffectiveAuth(other, "orders")).toBeUndefined();
    expect(connectionEffectiveAuth(manager, undefined)).toBeUndefined();
    recordConnectionEffectiveAuth(manager, "orders", "oauth");
    expect(connectionEffectiveAuth(manager, "orders")).toBe("oauth");
  });
});

describe("stamping", () => {
  it("replaces any effectiveAuth a challenge arrived with", () => {
    const forged = { ...parseChallengeHeader(HEADER), effectiveAuth: "discover" as const };
    expect(stampAuthChallenge(forged, "xaa").effectiveAuth).toBe("xaa");
    expect(stampAuthChallenge(forged, undefined)).not.toHaveProperty("effectiveAuth");
  });

  it("stamps a failure's challenge where the server is known", async () => {
    const manager = {};
    recordConnectionEffectiveAuth(manager, "orders", "discover");
    const error = await withStampedAuthChallenge(manager, "orders", async () => {
      throw http401();
    }).catch((caught) => caught);
    expect(readAuthChallenge(error)).toMatchObject({
      source: "http_401",
      requiredScope: "orders:read",
      effectiveAuth: "discover",
    });
  });

  it("leaves an error without a challenge alone", () => {
    const error = new Error("boom");
    stampErrorAuthChallenge(error, "discover");
    expect(readAuthChallenge(error)).toBeUndefined();
  });
});

describe("the completed-result envelope (the browser never parses the result itself)", () => {
  it.each(["discover", "oauth", "xaa", "none", "bearer"] as const)(
    "stamps a _meta challenge with the effective auth method %s",
    (effectiveAuth) => {
      expect(toolResultAuthChallengeEnvelope(META_RESULT, effectiveAuth)).toMatchObject({
        source: "tool_result_meta",
        effectiveAuth,
        facets: { hasErrorParams: true, hasResourceMetadata: true },
      });
    },
  );

  it("is absent for an ordinary result", () => {
    expect(
      toolResultAuthChallengeEnvelope({ content: [], isError: true }, "discover"),
    ).toBeUndefined();
  });
});

describe("local routes", () => {
  function captureJson() {
    const calls: Array<{ body: any; status?: number }> = [];
    return {
      c: {
        json: (body: unknown, status?: number) => {
          calls.push({ body, status });
          return { body, status };
        },
      },
      calls,
    };
  }

  it("serialize the stamped challenge on mcpError.authChallenge, keeping the 401", () => {
    const error = http401();
    stampErrorAuthChallenge(error, "discover");
    const { c, calls } = captureJson();
    jsonError(c, error, 500);
    expect(calls[0].status).toBe(401);
    expect(calls[0].body.mcpError.authChallenge).toMatchObject({
      source: "http_401",
      effectiveAuth: "discover",
      requiredScope: "orders:read",
    });
  });

  it("serialize a 403 step-up as a typed challenge too", () => {
    const serialized = serializeMcpError(
      new InsufficientScopeError({ requiredScope: "orders:write" } as never),
    ) as Record<string, any>;
    expect(serialized.authChallenge).toMatchObject({
      source: "http_403_insufficient_scope",
      requiredScope: "orders:write",
    });
  });
});

describe("hosted routes", () => {
  it("answer a mid-session 401 challenge with 403 UPSTREAM_AUTH_FAILED, never 401", () => {
    const error = http401();
    stampErrorAuthChallenge(error, "discover");
    const routeError = mapRuntimeError(error);
    // 401 would trigger authFetch's guest-session retry, which cannot help.
    expect(routeError.status).toBe(403);
    expect(routeError.code).toBe("UPSTREAM_AUTH_FAILED");
    expect(routeError.details).toMatchObject({
      upstreamAuthRequired: true,
      authChallenge: { source: "http_401", effectiveAuth: "discover" },
    });
    // No `oauthRequired`: surfaces that escalate on it would prompt twice.
    expect(routeError.details).not.toHaveProperty("oauthRequired");
  });

  it("recognize a headerless 401 as a challenge", () => {
    const routeError = mapRuntimeError(http401(""));
    expect(routeError.details?.authChallenge).toMatchObject({
      facets: { challengeHeader: "none" },
    });
  });

  it("reduce the challenge to what a sign-in reads (MJ-001)", () => {
    const projected = projectHostedAuthoredFailureDetails({
      upstreamAuthRequired: true,
      authChallenge: {
        ...parseChallengeHeader(HEADER),
        effectiveAuth: "discover",
      },
    });
    expect(projected?.authChallenge).toEqual({
      source: "http_401",
      error: "invalid_token",
      requiredScope: "orders:read",
      resourceMetadataUrl: PRM,
      effectiveAuth: "discover",
      facets: {
        challengeHeader: "bearer",
        hasResourceMetadata: true,
        hasScope: true,
        hasErrorParams: true,
      },
    });
  });

  it("keep a bare challenge: a 401 with no scope or pointer is still a request to sign in", () => {
    expect(
      projectAuthChallenge({
        source: "http_401",
        facets: { challengeHeader: "none" },
      }),
    ).toEqual({
      source: "http_401",
      facets: {
        challengeHeader: "none",
        hasResourceMetadata: false,
        hasScope: false,
        hasErrorParams: false,
      },
    });
  });

  it("drop a malformed challenge and anything that is not a URL or token", () => {
    expect(projectAuthChallenge({ source: "evil" })).toBeUndefined();
    expect(
      projectAuthChallenge({
        source: "http_401",
        resourceMetadataUrl: "javascript:alert(1)",
        // Scope tokens are printable ASCII (RFC 6749); a control character
        // is not one, so the scope is dropped. Rendering is text-only anyway.
        requiredScope: "orders\u0000read",
        effectiveAuth: "root",
        facets: {},
      }),
    ).toEqual({
      source: "http_401",
      facets: {
        challengeHeader: "none",
        hasResourceMetadata: false,
        hasScope: false,
        hasErrorParams: false,
      },
    });
  });
});

describe("the v1 envelope", () => {
  it("maps a sign-in challenge to AUTH_REQUIRED with details.authChallenge", () => {
    const error = http401();
    stampErrorAuthChallenge(error, "discover");
    const mapped = mapErrorToV1(error);
    expect(mapped.code).toBe("AUTH_REQUIRED");
    expect(mapped.details?.authChallenge).toMatchObject({
      source: "http_401",
      effectiveAuth: "discover",
    });
  });

  it("keeps an upstream credential refusal without a challenge as FORBIDDEN", () => {
    const error = Object.assign(new Error("forbidden"), {
      name: "MCPAuthError",
      statusCode: 403,
    });
    const mapped = mapErrorToV1(error);
    expect(mapped.code).not.toBe("AUTH_REQUIRED");
  });
});
