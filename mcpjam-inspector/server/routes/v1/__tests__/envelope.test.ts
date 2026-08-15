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
import { mapErrorToV1, v1Error } from "../envelope.js";
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

/**
 * The `/api/v1/*` surface returned its errors without ever telling
 * `requestLogContextMiddleware` what they were, so every v1 failure logged as
 * a bare `internal_error` with no message, no slug, and no origin — and was
 * therefore unreachable by the MCPJam-fault monitor no matter how badly it
 * failed. Measured 2026-08-15: 44 opaque 500s on eval-ingest in 72h.
 */
describe("v1Error — telemetry envelope", () => {
  function fakeContext() {
    const meta: Record<string, unknown> = {};
    return {
      set: (key: string, value: unknown) => {
        meta[key] = value;
      },
      json: (body: unknown, status: number) => ({ body, status }),
      meta,
    };
  }

  it("stashes webErrorMeta so the middleware stops logging a bare internal_error", () => {
    const c = fakeContext();

    v1Error(c as never, "NOT_FOUND", "no such thing");

    expect(c.meta.webErrorMeta).toMatchObject({
      status: V1_ERROR_STATUS.NOT_FOUND,
      code: "NOT_FOUND",
      message: "no such thing",
    });
  });

  it("carries attribution when the caller has it", () => {
    const c = fakeContext();

    v1Error(c as never, "INTERNAL_ERROR", "boom", undefined, {
      origin: "mcpjam",
      slug: "internal/unknown",
    });

    expect(c.meta.webErrorMeta).toMatchObject({
      origin: "mcpjam",
      slug: "internal/unknown",
    });
  });

  it("omits origin/slug rather than writing empty ones", () => {
    // An absent origin must stay absent: `isempty(origin)` is how the coverage
    // query finds unattributed rows, and an empty string would hide them.
    const c = fakeContext();

    v1Error(c as never, "VALIDATION_ERROR", "bad input");

    expect(c.meta.webErrorMeta).not.toHaveProperty("origin");
    expect(c.meta.webErrorMeta).not.toHaveProperty("slug");
  });

  it("does not throw when the context cannot set (non-Hono callers)", () => {
    expect(() =>
      v1Error({ json: () => ({}) } as never, "NOT_FOUND", "x"),
    ).not.toThrow();
  });
});

describe("mapErrorToV1 — attribution", () => {
  it("returns the effective origin and slug for a mapped runtime error", () => {
    const result = mapErrorToV1(new Error("connect ECONNREFUSED 127.0.0.1:1"));

    expect(result.origin).toBeDefined();
    expect(result.slug).toBeDefined();
  });

  it("does not attribute a user's refused connection to MCPJam", () => {
    // The whole point of the origin axis: this must never page us.
    const result = mapErrorToV1(new Error("connect ECONNREFUSED 127.0.0.1:1"));

    expect(result.origin).not.toBe("mcpjam");
  });

  it("preserves an origin the throwing site already promoted", () => {
    // A route that declared an internal hop resolved `mcpjam` and Sentry was
    // paged on it. Recomputing here would report `ambiguous` for a failure we
    // already own — the drift that kept `origin=mcpjam` out of Axiom.
    const err = new WebRouteError(502, ErrorCode.SERVER_UNREACHABLE, "boom");
    err.origin = "mcpjam";

    expect(mapErrorToV1(err).origin).toBe("mcpjam");
  });
});
