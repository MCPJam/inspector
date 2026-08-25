/**
 * `/api/v1/*` failures have to be VISIBLE — the capture matrix and the log
 * metadata behind it.
 *
 * Before this, the v1 router bypassed the whole capture policy: `v1OnError`
 * returned the envelope and did nothing else, so a route answering 500 to
 * every caller produced zero Sentry events, and its Axiom rows carried the
 * `errorCode: "internal_error"` fallback with no message, origin or slug.
 *
 * The subtle half is WHICH failures may page. `v1OnError` declares
 * `boundary: "mcpjam_internal"` because it fronts our own handlers, but two
 * things must survive that declaration: the branches that classify an upstream
 * server's refusal (they run first and their verdicts win), and the deliberate
 * 4xx envelopes v1 handlers throw as ordinary control flow. The tests below are
 * mostly about those two, because getting them wrong pages the on-call for
 * somebody else's MCP server, or for every 404.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import * as Sentry from "@sentry/node";
import { Hono } from "hono";
import { MCPAuthError } from "@mcpjam/sdk";
import { mapErrorToV1, v1OnError } from "../envelope.js";
import { ErrorCode, WebRouteError, mapRuntimeError } from "../../web/errors.js";
import { translateConvexWriteError } from "../convex-errors.js";
import { translateConvexReadError } from "../convex-read-errors.js";
import { requireConvexIdShape } from "../convex-id-param.js";
import { logger } from "../../../utils/logger.js";

const captureException = vi.mocked(Sentry.captureException);

beforeEach(() => {
  captureException.mockClear();
  vi.restoreAllMocks();
});

const INTERNAL = { boundary: "mcpjam_internal" } as const;

describe("v1 capture boundary — what pages", () => {
  it("pages once for an unclassified throw from our own handler", () => {
    // The bucket that reached Sentry through no path at all: a `TypeError` in
    // a v1 handler classifies as `internal/unknown` -> `ambiguous`, which the
    // strict policy declines, and nothing downstream rethrows it.
    const result = mapErrorToV1(new TypeError("x is not a function"), INTERNAL);

    expect(result.code).toBe("INTERNAL_ERROR");
    expect(result.origin).toBe("mcpjam");
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("does not page without the boundary — the declaration is what promotes", () => {
    // Same error, no declaration: still `ambiguous`, still measured in Axiom,
    // still not paged. This is the guard that the boundary is doing the work
    // rather than some incidental change to the classifier.
    const result = mapErrorToV1(new TypeError("x is not a function"));

    expect(result.origin).toBe("ambiguous");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("tags the capture with the boundary that caused it", () => {
    mapErrorToV1(new TypeError("boom"), INTERNAL);

    const [, options] = captureException.mock.calls[0] as [unknown, any];
    expect(options.tags.error_boundary).toBe("mcpjam_internal");
    expect(options.tags.error_origin).toBe("mcpjam");
    // Kept distinct so a triager can see the capture came from a declaration
    // rather than from the catalog.
    expect(options.extra.declaredOrigin).toBe("ambiguous");
  });

  it("never double-captures an error something else already ruled on", () => {
    const error = new TypeError("already seen");
    // A route catch-site that mapped it first, then rethrew into onError.
    mapRuntimeError(error);
    captureException.mockClear();

    mapErrorToV1(error, INTERNAL);

    expect(captureException).not.toHaveBeenCalled();
  });
});

describe("v1 capture boundary — what must NOT page", () => {
  it("leaves an upstream server's OAuth demand unpaged", () => {
    // The real class — `isMCPAuthError` is an `instanceof` check, and this
    // branch runs BEFORE the boundary is applied. If the declaration reached
    // it first, someone else's server demanding a grant would page us.
    const error = new MCPAuthError("Unauthorized", 401);

    const result = mapErrorToV1(error, INTERNAL);

    expect(result.code).toBe("OAUTH_REQUIRED");
    expect(result.origin).not.toBe("mcpjam");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("leaves a server that does not implement a primitive unpaged", () => {
    const error = Object.assign(
      new Error("MCP error -32601: Method not found"),
      {
        code: -32601,
      }
    );

    const result = mapErrorToV1(error, INTERNAL);

    expect(result.code).toBe("FEATURE_NOT_SUPPORTED");
    expect(captureException).not.toHaveBeenCalled();
  });

  it.each([
    [404, ErrorCode.NOT_FOUND, "no such project"],
    [403, ErrorCode.FORBIDDEN, "not an admin here"],
    [400, ErrorCode.VALIDATION_ERROR, "bad cursor"],
    [409, ErrorCode.CONFLICT, "changed since you loaded it"],
  ])("leaves a deliberate %i envelope unpaged", (status, code, message) => {
    // v1 handlers throw these as ordinary control flow and they reach
    // `onError` exactly like a crash does. Promoting on the declaration
    // alone would page for every not-found.
    const result = mapErrorToV1(
      new WebRouteError(status, code, message),
      INTERNAL
    );

    expect(result.origin).not.toBe("mcpjam");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("leaves an upstream server's credential refusal unpaged", () => {
    // A transport 403 is not an `MCPAuthError`, so it falls past the branch
    // above into the classifier and exits as UPSTREAM_AUTH_FAILED -> FORBIDDEN.
    // Still the user's server refusing us, still not ours to page on.
    const error = Object.assign(
      new Error("Error POSTing to endpoint (HTTP 403): forbidden"),
      { code: 403 }
    );

    const result = mapErrorToV1(error, INTERNAL);

    expect(result.code).toBe("FORBIDDEN");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("leaves an upstream-hop verdict alone even under the declaration", () => {
    // A connection failure carries positive evidence about whose hop broke.
    // The boundary doc is explicit that a declaration must not overrule
    // evidence, so this keeps its catalog origin.
    const result = mapErrorToV1(
      new Error("connect ECONNREFUSED 127.0.0.1:8080"),
      INTERNAL
    );

    expect(result.code).toBe("SERVER_UNREACHABLE");
    expect(result.origin).not.toBe("mcpjam");
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe("v1OnError — log metadata", () => {
  async function statusAndMeta(error: unknown) {
    const app = new Hono();
    let meta: Record<string, unknown> | undefined;
    app.get("/boom", () => {
      throw error;
    });
    app.onError((err, c) => {
      const response = v1OnError(err, c);
      meta = c.var.webErrorMeta as Record<string, unknown> | undefined;
      return response;
    });
    const res = await app.request("/boom");
    return { status: res.status, meta };
  }

  it("stashes the cause so the Axiom row is not a bare internal_error", async () => {
    const { status, meta } = await statusAndMeta(new TypeError("boom"));

    expect(status).toBe(500);
    expect(meta).toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
      message: "boom",
      origin: "mcpjam",
    });
  });

  it("stashes the V1 status, not the internal one it was mapped from", async () => {
    // `requestLogContextMiddleware` only trusts meta whose status matches the
    // response it observed. UPSTREAM_AUTH_FAILED is a 502 internally and a 403
    // on the wire, so stashing the internal status would silently discard the
    // metadata for this whole class.
    const { status, meta } = await statusAndMeta(
      new WebRouteError(
        502,
        ErrorCode.UPSTREAM_AUTH_FAILED,
        'Authentication failed for MCP server "acme"',
        { upstreamAuthRequired: true }
      )
    );

    expect(status).toBe(403);
    expect(meta).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("carries code and message on a deliberate 404 too", async () => {
    // 4xx rows get the same treatment: an abnormal RATE of one 4xx class is
    // the signal, and it is undiagnosable without the code.
    const { status, meta } = await statusAndMeta(
      new WebRouteError(404, ErrorCode.NOT_FOUND, "Journey not found")
    );

    expect(status).toBe(404);
    expect(meta).toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Journey not found",
    });
  });
});

describe("translateConvexWriteError — the unrecognized failure", () => {
  it("answers 500 and logs, not a silent 400", () => {
    // A broken write path used to report itself as the caller's malformed
    // input: below every 5xx monitor, and this function had no logger at all.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = translateConvexWriteError(
      new Error("Uncaught ConvexError: something nobody has seen before"),
      { resource: "Journey" }
    );

    expect(result.status).toBe(500);
    expect(result.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("logs WITHOUT capturing — the envelope owns the single Sentry event", () => {
    // Every caller throws this `WebRouteError`, so `v1OnError` maps it (500 +
    // INTERNAL_ERROR, exactly what the boundary promotes) and captures there.
    // A `logger.error` here would capture a DIFFERENT object — the redacted
    // Error, which carries no stamp — so one failure would arrive in Sentry
    // twice under two fingerprints.
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const routeError = translateConvexWriteError(
      new Error("Uncaught ConvexError: unrecognized"),
      { resource: "Journey" }
    );
    expect(captureException).not.toHaveBeenCalled();

    mapErrorToV1(routeError, INTERNAL);

    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("puts the detail on a key Axiom will not overwrite", () => {
    // `ingestToAxiom` spreads the context and THEN sets `message` from the log
    // message, so a `message` key would be silently dropped — taking the whole
    // diagnosis with it.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    translateConvexWriteError(new Error("Uncaught ConvexError: mystery"), {
      resource: "Journey",
    });

    const [, context] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(context.message).toBeUndefined();
    expect(context.detail).toContain("mystery");
  });

  it("does not forward Convex's prose to the caller on the 500", () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = translateConvexWriteError(
      new Error(
        "Uncaught ConvexError: journeys.js:412 failed [Request ID: abc123]"
      ),
      { resource: "Journey", fallbackMessage: "Journey write rejected" }
    );

    expect(result.message).toBe("Journey write rejected");
    expect(result.message).not.toContain("Request ID");
    expect(result.message).not.toContain("journeys.js");
  });

  it("redacts credentials out of what it does log", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    // Assembled at runtime: a literal live-key-shaped string in the tree
    // trips secret scanners, and a scanner alert nobody can action is how
    // real ones start getting ignored.
    const token = ["sk", "live", "abcdef123456"].join("_");
    translateConvexWriteError(new Error(`rejected token ${token} on write`), {
      resource: "Server",
    });

    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).not.toContain(token);
    expect(logged).toContain("sk_[redacted]");
  });

  it.each([
    ["CONFLICT", 409],
    ["VALIDATION", 400],
    ["NOT_FOUND", 404],
  ])("still answers %s structurally, without logging", (code, status) => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const convexError = Object.assign(new Error("x"), {
      data: { code, message: "structured" },
    });

    expect(
      translateConvexWriteError(convexError, { resource: "Host" }).status
    ).toBe(status);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    "A journey needs a goal",
    "Environment does not belong to this project",
    'Environment "prod" is archived',
    "A journey must target at least one host",
  ])("keeps a deliberate prose refusal a 400 with its message: %s", (copy) => {
    // The backend's mutations throw `new ConvexError('<prose>')` — string
    // data, no {code} — as their ordinary user-facing refusals, and ConvexError
    // data is what production redaction preserves, which is why customer copy
    // lives there. Routing these into the 500 fallback would page the on-call
    // every time a user forgets a goal, and replace the sentence written to
    // help them with a generic error.
    const error = vi.spyOn(logger, "error").mockImplementation(() => {});
    const convexError = Object.assign(
      new Error(`Uncaught ConvexError: ${copy}`),
      { data: copy }
    );

    const result = translateConvexWriteError(convexError, {
      resource: "Journey",
    });
    expect(result.status).toBe(400);
    expect(result.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(result.message).toBe(copy);
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["empty string", ""],
    ["whitespace only", "   "],
  ])(
    "does not read %s data as a prose refusal — it is unrecognized",
    (_label, data) => {
      // The boundary of the string-data branch. Empty or blank data is not a
      // sentence anyone wrote for the caller, so treating it as one would
      // answer 400 with a BLANK message — the least useful response the API
      // can produce, and it would also hide a broken write path from the 5xx
      // monitor. These fall through to the unrecognized 500 instead.
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const convexError = Object.assign(
        new Error("Uncaught ConvexError: unrecognized"),
        { data }
      );

      const result = translateConvexWriteError(convexError, {
        resource: "Journey",
        fallbackMessage: "Journey write rejected",
      });

      expect(result.status).toBe(500);
      expect(result.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(result.message).toBe("Journey write rejected");
      expect(warn).toHaveBeenCalledTimes(1);
    }
  );

  it("uses the default fallback copy when the caller supplied none", () => {
    // The 500 never forwards Convex's text, so the default is the only thing
    // an unconfigured caller shows — it must not leak and must not be blank.
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = translateConvexWriteError(
      new Error("Uncaught ConvexError: journeys.js:412 [Request ID: abc123]"),
      { resource: "Journey" }
    );

    expect(result.message).toBe("Journey write rejected by the platform");
    expect(result.message).not.toContain("journeys.js");
    expect(result.message).not.toContain("Request ID");
  });

  it("does not let string data bypass the coded prose mappings", () => {
    // A string that happens to say "already exists" must keep its 409 — the
    // prose branches run first, and this pins that ordering.
    const convexError = Object.assign(
      new Error(
        "Uncaught ConvexError: a persona with that name already exists"
      ),
      { data: "a persona with that name already exists" }
    );
    expect(
      translateConvexWriteError(convexError, { resource: "Persona" }).status
    ).toBe(409);
  });
});

describe("translateConvexReadError — argument validation is warned, not paged", () => {
  it("warns on the branch that answers 404, so deploy skew is visible", () => {
    // The 404 has a second, much less benign cause than a stale caller id: a
    // backend validator change makes the route 404 for EVERYONE. Without a log
    // line that is invisible — wrong status class for a 5xx monitor, and no
    // Sentry event by design.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = translateConvexReadError(
      new Error(
        "ArgumentValidationError: Object is missing the required field"
      ),
      { scope: "v1.journeys" }
    );

    expect(result.status).toBe(404);
    expect(warn).toHaveBeenCalledTimes(1);
    // Axiom-only. `logger.warn` does not capture, which is the point: the
    // stale-id retry loops that motivated the 404 must stay free.
    expect(captureException).not.toHaveBeenCalled();
  });

  it("redacts the arguments the validator quoted back", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    translateConvexReadError(
      new Error(
        "ArgumentValidationError: got eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
      ),
      { scope: "v1.scenarios" }
    );

    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(logged).toContain("[redacted-jwt]");
  });

  it("puts the detail on a key Axiom will not overwrite", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    translateConvexReadError(
      new Error("ArgumentValidationError: bad id 'abc'"),
      { scope: "v1.journeys" }
    );

    const [, context] = warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(context.message).toBeUndefined();
    expect(context.detail).toContain("ArgumentValidationError");
  });

  it("leaves the membership 404 silent — it is a normal refusal", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = translateConvexReadError(
      new Error("Not a member of this project"),
      { scope: "v1.journeys" }
    );

    expect(result.status).toBe(404);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * The eval-run id incident, expressed as what it actually cost: not the 404,
 * the PAGE. A caller-supplied path segment Convex could not parse produced a
 * 500 that `mcpjam_internal` promoted to `origin=mcpjam` and captured, once
 * per retry, from a route a share-link guest can reach.
 */
describe("a malformed id parameter must not page", () => {
  const MULTI_ID =
    "mh78djdyf2dqbmxky71sz9y6x58d5p2c mh7ck9qd0hzc7a2ckd3546ebq58d4yd3";

  function reject(): unknown {
    try {
      requireConvexIdShape(MULTI_ID, "runId", {
        scope: "v1.evals",
        notFoundMessage: "Eval run not found",
      });
    } catch (error) {
      return error;
    }
    throw new Error("expected the id gate to reject");
  }

  it("captures nothing, even under the internal boundary", () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});

    const result = mapErrorToV1(reject(), INTERNAL);

    expect(result.code).toBe("NOT_FOUND");
    // The whole point. Before the gate this was INTERNAL_ERROR, the one
    // combination `effectiveBoundary` promotes to `mcpjam` — so a guest with a
    // bad id could mint paging Sentry events at will.
    expect(result.origin).not.toBe("mcpjam");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("counts the rejection in Axiom instead of going silent", () => {
    // Not silence: the gate's other failure mode is a Convex id-format change,
    // which would 404 EVERY caller under a status no 5xx monitor watches. The
    // warn is what makes that visible and rate-alertable.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    reject();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      scope: "v1.evals",
      param: "runId",
    });
  });
});

/**
 * The gate logs the value it rejected, and the value is whatever a client put
 * in an id slot — including what a MIS-BUILT URL puts there. This line is
 * designed to fire on high-volume retry loops, so anything it forwards
 * verbatim accumulates in Axiom.
 */
describe("the id gate redacts before it truncates", () => {
  // Assembled at runtime, and NOT with a real provider's prefix. A literal
  // `sk_live_…` in a fixture is indistinguishable from a leaked Stripe key to
  // GitHub's push protection, which blocks the push — so the fixture uses this
  // repo's own service-credential prefix (`slk_`, `surface-service-auth.ts`)
  // and builds it from parts. `CREDENTIAL_PATTERN` covers `sk|slk|dsc|api`
  // identically, so the assertion is unchanged.
  const FAKE_SECRET = ["notareal", "servicekey", "fixture", "0123456789"].join(
    ""
  );
  const FAKE_CREDENTIAL = `slk${"_"}${FAKE_SECRET}`;

  it("does not put a caller-supplied credential in the log line", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    try {
      requireConvexIdShape(FAKE_CREDENTIAL, "runId", {
        scope: "v1.evals",
        notFoundMessage: "Eval run not found",
      });
    } catch {
      // expected
    }

    const detail = String(
      (warn.mock.calls[0]?.[1] as Record<string, unknown> | undefined)?.detail ??
        ""
    );
    expect(detail).not.toContain(FAKE_SECRET);
    // Still says WHICH credential shape was rejected — that is the diagnostic
    // value, and it is what makes a mis-built client identifiable at all.
    expect(detail).toContain("redacted");
  });

  it("redacts BEFORE the 64-character cut, not after", () => {
    // Order is the whole finding. Slicing first can cut a secret in half and
    // leave a fragment `CREDENTIAL_PATTERN` no longer recognizes — which is how
    // a scrubber silently stops scrubbing. The padding here pushes the secret
    // across the 64-character boundary so the wrong order is observable.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    try {
      requireConvexIdShape(`${"p".repeat(50)} ${FAKE_CREDENTIAL}`, "runId", {
        scope: "v1.evals",
        notFoundMessage: "Eval run not found",
      });
    } catch {
      // expected
    }

    const detail = String(
      (warn.mock.calls[0]?.[1] as Record<string, unknown> | undefined)?.detail ??
        ""
    );
    expect(detail).not.toContain(FAKE_SECRET.slice(0, 12));
  });
});
