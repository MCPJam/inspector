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
      get: (key: string) => meta[key],
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

  it("never clobbers the richer meta v1OnError already stashed", () => {
    // The ordering that makes this load-bearing: `v1OnError` stashes meta WITH
    // origin and slug, then calls `v1Error`. A blind write here would erase the
    // attribution one line after it was resolved — reintroducing the exact
    // blind spot this backstop exists to close.
    const c = fakeContext();
    c.meta.webErrorMeta = {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "classified",
      origin: "mcpjam",
      slug: "internal/unknown",
    };

    v1Error(c as never, "INTERNAL_ERROR", "classified");

    expect(c.meta.webErrorMeta).toMatchObject({
      origin: "mcpjam",
      slug: "internal/unknown",
    });
  });

  it("omits origin/slug rather than writing empty ones", () => {
    // An absent origin must stay absent: `isempty(origin)` is how the coverage
    // query finds unattributed rows, and an empty string would hide them. The
    // returned path has no classification to report — only a real code and
    // message, which still beat the middleware's `internal_error` fallback.
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

/**
 * A DELIBERATE backend refusal must reach the caller; an accident must not.
 *
 * Production, 2026-09-01: launching an eval run whose environment selects a
 * materialized secret answered
 * `{"code":"INTERNAL_ERROR","message":"[Request ID: …] Server Error"}`. The
 * backend had thrown
 * `ConvexError({ code: "ENV_MATERIALIZED_SECRETS_UNSUPPORTED", message: "…
 * Switch those secrets to brokered delivery …" })` — a machine code and the
 * remedy, in the same object — and the boundary flattened both. The real cause
 * was only readable in `npx convex logs --prod`.
 *
 * The second half of this block is the half that keeps the fix safe: an
 * UNSTRUCTURED throw still answers an opaque 500, because its message can
 * carry function names, request ids, and argument-validator output with the
 * arguments in it.
 */
describe("mapErrorToV1 — structured Convex refusals", () => {
  /** A `ConvexError` as the production error mask actually delivers it. */
  function convexError(
    data: unknown,
    message = "[Request ID: 9f2] Server Error",
  ) {
    return Object.assign(new Error(message), { data });
  }

  it("surfaces the backend's code and message as a 400 instead of a 500", () => {
    const result = mapErrorToV1(
      convexError({
        code: "ENV_MATERIALIZED_SECRETS_UNSUPPORTED",
        message:
          'Environment "X" selects 1 materialized secret, which hosted eval runs cannot deliver. Switch those secrets to brokered delivery, or remove them from this environment, before launching it.',
      }),
      { boundary: "mcpjam_internal" },
    );

    expect(result.code).toBe("VALIDATION_ERROR");
    expect(V1_ERROR_STATUS[result.code]).toBe(400);
    expect(result.message).toContain("brokered delivery");
    // The backend code rides in `details` because the public code union is
    // closed — the same channel the ENV_* resolve failures already use.
    expect(result.details).toMatchObject({
      code: "ENV_MATERIALIZED_SECRETS_UNSUPPORTED",
    });
  });

  it("never forwards Convex's own framing", () => {
    const result = mapErrorToV1(
      convexError({ code: "ENV_SOMETHING_NEW", message: "Fix the thing." }),
    );

    expect(result.message).toBe("Fix the thing.");
    expect(result.message).not.toContain("Request ID");
    expect(result.message).not.toContain("Server Error");
  });

  it("keeps a coded refusal's canonical status where the table knows it", () => {
    // The generic 400 is the DEFAULT, not a flattening: a code with a branch
    // of its own keeps the status that branch chose.
    const limited = mapErrorToV1(
      convexError({
        code: "billing_limit_reached",
        message: "Plan limit reached.",
      }),
    );
    expect(limited.code).toBe("RATE_LIMITED");

    const conflict = mapErrorToV1(
      convexError({ code: "CONFLICT", message: "Someone else edited it." }),
    );
    expect(conflict.code).toBe("CONFLICT");
  });

  it("does not let a coded NOT_FOUND leak the backend's prose", () => {
    // The boundary has no route noun to borrow, so a 404 answers with the
    // neutral copy rather than whatever the backend said about the resource.
    const result = mapErrorToV1(
      convexError({
        code: "NOT_FOUND",
        message: "environment env_7 is not attached to suite ts_3",
      }),
    );

    expect(result.code).toBe("NOT_FOUND");
    expect(result.message).toBe("Not found");
  });

  // ── The guard rail ───────────────────────────────────────────────────
  //
  // Everything below must keep the opaque 500 it had before the branch above
  // existed. `code` is what marks a throw deliberate; without one there is no
  // evidence anybody chose to say this to a caller.

  it("keeps an unstructured throw an opaque 500", () => {
    const result = mapErrorToV1(
      new Error(
        "Uncaught Error: journeyRuns.js:785 secretRef leaked [Request ID: abc]",
      ),
      { boundary: "mcpjam_internal" },
    );

    expect(result.code).toBe("INTERNAL_ERROR");
    expect(V1_ERROR_STATUS[result.code]).toBe(500);
  });

  it("keeps a ConvexError with no code an opaque 500", () => {
    const result = mapErrorToV1(
      convexError({ message: "internal detail nobody chose to publish" }),
    );

    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.message).not.toContain("internal detail");
  });

  it("keeps a coded ConvexError with no message an opaque 500", () => {
    // A code alone is a contract with no copy behind it. The alternative —
    // answering 400 and reaching for `error.message` — would publish Convex's
    // framing, which is the one thing this must never do. So the payload's own
    // `message` is the only prose the branch will forward, and without it the
    // error is not eligible at all.
    const result = mapErrorToV1(convexError({ code: "SOME_CODE" }));

    expect(result.code).toBe("INTERNAL_ERROR");
    // Nothing from `data` reached the caller.
    expect(result.details?.code).toBeUndefined();
  });

  it("keeps a non-object `data` payload out of the branch", () => {
    // String `data` is the backend's ordinary prose refusal. It has its own
    // handling inside the write translator, where a route supplies the noun;
    // at the boundary it is not a coded contract, so nothing changes here.
    const result = mapErrorToV1(convexError("a journey needs a goal"));

    expect(result.code).toBe("INTERNAL_ERROR");
  });

  it("leaves a route's own WebRouteError untouched", () => {
    const err = new WebRouteError(409, ErrorCode.CONFLICT, "stale revision");

    const result = mapErrorToV1(err);

    expect(result.code).toBe("CONFLICT");
    expect(result.message).toBe("stale revision");
  });

  it("still answers a transport failure as a transport failure", () => {
    // A dead socket must not be re-read as the caller's bad input just
    // because it arrived on a Convex call.
    const result = mapErrorToV1(new Error("fetch failed"));

    expect(result.code).not.toBe("VALIDATION_ERROR");
  });

  it("keeps a `data: null` payload out of the branch", () => {
    // The eligibility read is `error.data`, and `null` is what an ordinary
    // `throw new Error()` decorated by nothing at all looks like on that
    // property. It has no code, so there is no evidence anybody chose to say
    // this to a caller.
    const result = mapErrorToV1(convexError(null), {
      boundary: "mcpjam_internal",
    });

    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.details?.code).toBeUndefined();
  });

  it.each([
    ["an empty code", { code: "", message: "Fix the thing." }],
    ["a blank code", { code: "   ", message: "Fix the thing." }],
    ["an empty message", { code: "ENV_SOMETHING_NEW", message: "" }],
    ["a blank message", { code: "ENV_SOMETHING_NEW", message: "   " }],
    ["both blank", { code: "  ", message: "\t\n " }],
  ])("keeps %s an opaque 500", (_label, data) => {
    // PRESENT is not the gate; NON-BLANK is. A whitespace `message` would
    // answer 400 with an empty sentence — worse than the 500 it replaced,
    // because the caller gets nothing AND the failure stops being logged as
    // one we did not understand.
    const result = mapErrorToV1(convexError(data), {
      boundary: "mcpjam_internal",
    });

    expect(result.code).toBe("INTERNAL_ERROR");
    expect(V1_ERROR_STATUS[result.code]).toBe(500);
    expect(result.details?.code).toBeUndefined();
    expect(result.message).not.toContain("Fix the thing");
  });

  it("is not misread by its own copy on a deployment with no error mask", () => {
    // The production mask reduces `error.message` to "[Request ID: …] Server
    // Error", but a deployment without it delivers Convex's framing wrapped
    // around the JSON of `data` — the backend's own sentence INCLUDED. The
    // write translator's prose fallbacks read that message, so a refusal whose
    // remedy happens to say "not found" was answered as a 404 carrying neither
    // the message nor the code. The coded-but-unknown branch runs ahead of
    // those patterns now, and behind every canonical code branch.
    const message = "Secret sec_1 is not found in this project.";
    const data = { code: "ENV_SECRET_MISSING", message };

    const result = mapErrorToV1(
      convexError(data, `Uncaught ConvexError: ${JSON.stringify(data)}`),
      { boundary: "mcpjam_internal" },
    );

    expect(result.code).toBe("VALIDATION_ERROR");
    expect(V1_ERROR_STATUS[result.code]).toBe(400);
    expect(result.message).toBe(message);
    expect(result.details).toMatchObject({ code: "ENV_SECRET_MISSING" });
  });

});
