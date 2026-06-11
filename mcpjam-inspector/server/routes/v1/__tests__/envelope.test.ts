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
