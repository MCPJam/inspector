/**
 * Tests for `mapErrorToV1` — the v1 contract's error promotion layer.
 *
 * Focus on the OAuth disambiguation: hosted authorize/connect throws
 * `WebRouteError(UNAUTHORIZED, details: { oauthRequired: true })` upstream of
 * the MCP SDK. Without the explicit promotion in `mapErrorToV1`, callers can
 * not tell "your bearer is bad" from "this server needs OAuth" — both flatten
 * to UNAUTHORIZED, defeating the v1 closed-union contract.
 */
import { describe, it, expect } from "vitest";
import { mapErrorToV1 } from "../envelope.js";
import { V1_ERROR_STATUS } from "../contract.js";
import { ErrorCode, WebRouteError } from "../../web/errors.js";

describe("mapErrorToV1 — OAUTH_REQUIRED promotion", () => {
  it("promotes hosted authorize/connect oauthRequired errors to OAUTH_REQUIRED", () => {
    const err = new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      'Server "notion" requires OAuth authentication.',
      {
        oauthRequired: true,
        serverId: "srv_abc",
        serverName: "notion",
        serverUrl: "https://notion-mcp.example.com",
      }
    );

    const result = mapErrorToV1(err);

    expect(result.code).toBe("OAUTH_REQUIRED");
    expect(result.message).toContain("OAuth");
    expect(result.details).toMatchObject({
      oauthRequired: true,
      serverId: "srv_abc",
      serverName: "notion",
      serverUrl: "https://notion-mcp.example.com",
    });
  });

  it("leaves UNAUTHORIZED unchanged when details.oauthRequired is absent", () => {
    const err = new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "Bad bearer token"
    );

    const result = mapErrorToV1(err);

    expect(result.code).toBe("UNAUTHORIZED");
    expect(result.message).toBe("Bad bearer token");
  });

  it("does not promote when details.oauthRequired is falsy", () => {
    const err = new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "Some other unauthorized case",
      { oauthRequired: false, foo: "bar" }
    );

    const result = mapErrorToV1(err);

    expect(result.code).toBe("UNAUTHORIZED");
  });

  it("does not promote a non-UNAUTHORIZED error that happens to carry oauthRequired", () => {
    // Defensive: oauthRequired only means anything paired with UNAUTHORIZED.
    const err = new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Internal failure",
      { oauthRequired: true }
    );

    const result = mapErrorToV1(err);

    expect(result.code).toBe("INTERNAL_ERROR");
  });
});

describe("mapErrorToV1 — FEATURE_NOT_SUPPORTED promotion", () => {
  it("maps MCP -32601 Method-not-found errors to FEATURE_NOT_SUPPORTED", () => {
    // Shape of the SDK's McpError: an Error carrying the numeric JSON-RPC
    // code. prompts/get against a server with no prompts capability throws
    // exactly this; it must NOT surface as a 500.
    const err = Object.assign(new Error("MCP error -32601: Method not found"), {
      code: -32601,
    });

    const result = mapErrorToV1(err);

    expect(result.code).toBe("FEATURE_NOT_SUPPORTED");
    expect(result.message).toContain("Method not found");
  });

  it("does not promote other JSON-RPC error codes", () => {
    const err = Object.assign(new Error("MCP error -32602: Invalid params"), {
      code: -32602,
    });

    const result = mapErrorToV1(err);

    expect(result.code).toBe("INTERNAL_ERROR");
  });
});

describe("mapErrorToV1 — upstream auth refusals", () => {
  it("maps UPSTREAM_AUTH_FAILED to FORBIDDEN, not the unknown-code 500", () => {
    // `UPSTREAM_AUTH_FAILED` is Inspector-internal and deliberately absent
    // from the shared `INTERNAL_TO_V1_CODE` table (the Convex backend keeps a
    // byte-identical copy and never emits this code), so without the explicit
    // branch in `mapErrorToV1` it hits `mapInternalCode`'s unknown-code
    // default and reaches CLI/worker callers as a 500 INTERNAL_ERROR — the
    // exact misreport the classification exists to remove.
    const err = new WebRouteError(
      403,
      ErrorCode.UPSTREAM_AUTH_FAILED,
      'Authentication failed for MCP server "acme": HTTP 403',
      { upstreamAuthRequired: true }
    );

    const result = mapErrorToV1(err);

    expect(result.code).toBe("FORBIDDEN");
    expect(result.details).toMatchObject({ upstreamAuthRequired: true });
  });

  it("classifies a transport 403 end-to-end as FORBIDDEN", () => {
    // Shape of the MCP SDK's StreamableHTTPError/SseError: an Error carrying
    // the numeric HTTP status. It is NOT an `MCPAuthError`, so the
    // OAUTH_REQUIRED promotion at the top of `mapErrorToV1` declines it and it
    // falls through to the runtime classifier.
    const err = Object.assign(
      new Error("Error POSTing to endpoint (HTTP 403): forbidden"),
      { code: 403 }
    );

    expect(mapErrorToV1(err).code).toBe("FORBIDDEN");
  });

  it("still answers 403 for the FORBIDDEN code the v1 status map carries", () => {
    // Guard on the pairing, not just the code: the whole point is that these
    // stop being 5xx. `V1_ERROR_STATUS.FORBIDDEN` is the contract's answer.
    const err = new WebRouteError(
      403,
      ErrorCode.UPSTREAM_AUTH_FAILED,
      "refused",
      { upstreamAuthRequired: true }
    );

    expect(V1_ERROR_STATUS[mapErrorToV1(err).code]).toBe(403);
  });
});

describe("mapErrorToV1 — passthrough", () => {
  it("maps a generic non-WebRouteError into INTERNAL_ERROR", () => {
    const result = mapErrorToV1(new Error("boom"));
    expect(result.code).toBe("INTERNAL_ERROR");
  });

  it("maps NOT_FOUND through the internal->v1 code map", () => {
    const err = new WebRouteError(404, ErrorCode.NOT_FOUND, "no such thing");
    const result = mapErrorToV1(err);
    expect(result.code).toBe("NOT_FOUND");
  });
});
