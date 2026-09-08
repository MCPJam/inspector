import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
import * as Sentry from "@sentry/node";
const captureException = vi.mocked(Sentry.captureException);
import { MCPAuthError, originOf } from "@mcpjam/sdk";
import { InsufficientScopeError } from "@modelcontextprotocol/client";

import {
  ErrorCode,
  WebRouteError,
  mapRuntimeError,
  mapTargetServerError,
  webErrorFromRoute,
} from "../errors.js";
import { isOriginCaptureHandled } from "../../../utils/error-origin-capture.js";

describe("mapRuntimeError", () => {
  it("passes WebRouteError through unchanged", () => {
    const original = new WebRouteError(404, ErrorCode.NOT_FOUND, "missing");
    expect(mapRuntimeError(original)).toBe(original);
  });

  it("maps timeout messages to 504", () => {
    expect(mapRuntimeError(new Error("Request timed out")).status).toBe(504);
    expect(mapRuntimeError(new Error("Timeout exceeded")).status).toBe(504);
  });

  it("maps a raw 401 from the target server to 401 UNAUTHORIZED without oauthRequired", () => {
    const mapped = mapRuntimeError(
      Object.assign(new Error("Error POSTing to endpoint (HTTP 401)"), {
        statusCode: 401,
      }),
    );
    expect(mapped.status).toBe(401);
    expect(mapped.code).toBe(ErrorCode.UNAUTHORIZED);
    // No per-server auth context here — the escalation tag is applied only
    // where the effective auth method is known.
    expect(mapped.details?.oauthRequired).toBeUndefined();
  });

  describe("upstream auth rejections", () => {
    // The SDK raises this exact shape from `MCPClientManager`'s connect path
    // (`new MCPAuthError('Authentication failed for MCP server "…": …',
    // authCheck.statusCode, { cause })`). 3,706 of them landed on
    // `/api/web/tools/list` in 30 days, every one reported as a 500
    // INTERNAL_ERROR — an MCPJam fault code for the user's server refusing our
    // credentials.
    function upstreamAuthError(statusCode?: number, detail = "") {
      return new MCPAuthError(
        `Authentication failed for MCP server "acme": Streamable HTTP error: ${detail}`,
        statusCode,
      );
    }

    // The spec's authorization error table is identical in 2025-03-26,
    // 2025-06-18, 2025-11-25, 2026-07-28 and draft: 401 (token invalid), 403
    // (insufficient permissions), 400 (malformed authorization request). All
    // three are legitimate upstream auth rejections, so none of them may be
    // reported as an MCPJam internal error.
    it.each([401, 403, 400])(
      "never reports an upstream %i auth rejection as 500 INTERNAL_ERROR",
      (statusCode) => {
        const mapped = mapRuntimeError(upstreamAuthError(statusCode));

        expect(mapped.status).not.toBe(500);
        expect(mapped.code).not.toBe(ErrorCode.INTERNAL_ERROR);
      },
    );

    it("never reports a status-less auth rejection as 500 INTERNAL_ERROR", () => {
      // `isAuthError` returns no statusCode when it recognized the failure by
      // message alone, so the MCPAuthError the SDK builds carries none.
      const mapped = mapRuntimeError(upstreamAuthError(undefined));

      expect(mapped.status).not.toBe(500);
      expect(mapped.code).not.toBe(ErrorCode.INTERNAL_ERROR);
    });

    it("keeps a clean upstream 401 on the existing 401 UNAUTHORIZED branch", () => {
      const mapped = mapRuntimeError(upstreamAuthError(401));

      expect(mapped.status).toBe(401);
      expect(mapped.code).toBe(ErrorCode.UNAUTHORIZED);
    });

    it.each([403, 400, undefined])(
      "maps an upstream %s auth rejection to 403 UPSTREAM_AUTH_FAILED",
      (statusCode) => {
        const mapped = mapRuntimeError(upstreamAuthError(statusCode));

        expect(mapped.status).toBe(403);
        expect(mapped.code).toBe(ErrorCode.UPSTREAM_AUTH_FAILED);
        expect(mapped.details?.upstreamAuthRequired).toBe(true);
      },
    );

    it("does NOT widen the guest-retry 401 surface", () => {
      // `authFetch` retries any 401 from `/api/web/*` for an actor with no
      // WorkOS session (`shouldRetryApiAuth401`) by force-refreshing the guest
      // token and replaying — and the hosted `webError` envelope cannot send
      // the `X-MCP-Auth-Required: oauth` header that suppresses it. Sending
      // these thousands of upstream rejections back as 401 would put every
      // guest through a refresh + replay that cannot fix the failure.
      for (const statusCode of [403, 400, undefined]) {
        expect(mapRuntimeError(upstreamAuthError(statusCode)).status).not.toBe(
          401,
        );
      }
    });

    it("still carries the normalized block and the effective origin", () => {
      // The whole point of moving off INTERNAL_ERROR is attribution, so the
      // envelope must keep saying whose failure this was: `user_config`, which
      // is also what keeps the strict Sentry policy from paging us for it.
      const mapped = mapRuntimeError(upstreamAuthError(403));

      expect(mapped.normalized?.slug).toBeTruthy();
      expect(originOf(mapped.normalized)).toBe("user_config");
      expect(mapped.origin).toBe("user_config");
    });

    it("outranks transport noise quoted inside the auth message", () => {
      // The connect path quotes BOTH the Streamable HTTP and the SSE failure in
      // one message, so an auth rejection routinely carries "fetch failed" or
      // "timed out" text. The SDK already classified it from the status codes;
      // a substring match must not override that.
      expect(
        mapRuntimeError(upstreamAuthError(403, "fetch failed")).code,
      ).toBe(ErrorCode.UPSTREAM_AUTH_FAILED);
      expect(
        mapRuntimeError(upstreamAuthError(403, "the request timed out")).code,
      ).toBe(ErrorCode.UPSTREAM_AUTH_FAILED);
    });
  });

  // Regression: prod 500s on /api/web/{tools/list,chat-v2,servers/validate},
  // 2026-08-24. A customer's authorization server rejected a token refresh with
  // `{"error":"invalid_grant","error_description":"Request context not
  // available — authentication or export lookup failed"}`. `parseErrorResponse`
  // turns that into an `OAuthResponseError` whose message is the description
  // VERBATIM — no status, no errno, no MCPJam prefix — so every branch here
  // missed it and it landed on the 500 catch-all. Their authorization server
  // was reported to them, and to the on-call, as an MCPJam internal error.
  describe("an OAuth error response from the user's authorization server", () => {
    const INCIDENT_MESSAGE =
      "Request context not available — authentication or export lookup failed";

    function oauthResponseError(message: string, code?: string) {
      const error = new Error(message) as Error & { code?: string };
      error.name = "OAuthResponseError";
      error.code = code;
      return error;
    }

    it("is never reported as a 500 INTERNAL_ERROR", () => {
      const mapped = mapRuntimeError(
        oauthResponseError(INCIDENT_MESSAGE, "invalid_grant"),
      );

      expect(mapped.status).not.toBe(500);
      expect(mapped.code).not.toBe(ErrorCode.INTERNAL_ERROR);
    });

    it("maps to 403 UPSTREAM_AUTH_FAILED", () => {
      const mapped = mapRuntimeError(
        oauthResponseError(INCIDENT_MESSAGE, "invalid_grant"),
      );

      expect(mapped.status).toBe(403);
      expect(mapped.code).toBe(ErrorCode.UPSTREAM_AUTH_FAILED);
      expect(mapped.details?.upstreamAuthRequired).toBe(true);
    });

    it("attributes the failure away from MCPJam", () => {
      // What keeps these out of the 5xx budget AND off the pager: the strict
      // capture policy never pages on a non-`mcpjam` origin.
      const mapped = mapRuntimeError(
        oauthResponseError(INCIDENT_MESSAGE, "invalid_grant"),
      );

      expect(mapped.normalized?.slug).toBe("oauth/invalid_grant");
      expect(mapped.origin).toBe("user_config");
    });

    it("classifies from the response shape even when the code is unrecognized", () => {
      // The authorization server chooses both the prose and the `error` code,
      // and a vendor-specific code is legal. The status must not depend on
      // recognizing either — only on the error being an OAuth error RESPONSE.
      const mapped = mapRuntimeError(
        oauthResponseError(INCIDENT_MESSAGE, "vendor_specific_failure"),
      );

      expect(mapped.status).toBe(403);
      expect(mapped.code).toBe(ErrorCode.UPSTREAM_AUTH_FAILED);
    });

    it("still reports the same sentence from an unidentified source as ours", () => {
      // The guard against over-correction. Nothing about these WORDS moved the
      // failure off 500 — a bare Error carrying the identical text has no
      // evidence naming an upstream, so it stays an MCPJam internal error and
      // keeps paging. Matching on the prose instead would have silenced
      // whatever else ever phrases a failure this way.
      const mapped = mapRuntimeError(new Error(INCIDENT_MESSAGE));

      expect(mapped.status).toBe(500);
      expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
    });
  });

  it("maps ECONN* errno messages to 502", () => {
    expect(
      mapRuntimeError(new Error("connect ECONNREFUSED 127.0.0.1:8080")).status,
    ).toBe(502);
    expect(mapRuntimeError(new Error("read ECONNRESET")).status).toBe(502);
    expect(mapRuntimeError(new Error("ECONNABORTED")).status).toBe(502);
  });

  it("maps standard connection-failure phrases to 502", () => {
    expect(
      mapRuntimeError(new Error("Connection refused by peer")).status,
    ).toBe(502);
    expect(mapRuntimeError(new Error("Connection reset")).status).toBe(502);
    expect(
      mapRuntimeError(new Error("Failed to connect to upstream")).status,
    ).toBe(502);
    expect(mapRuntimeError(new Error("fetch failed")).status).toBe(502);
    expect(
      mapRuntimeError(new Error("getaddrinfo ENOTFOUND example.com")).status,
    ).toBe(502);
    expect(mapRuntimeError(new Error("socket hang up")).status).toBe(502);
  });

  it("keeps the shared mapper on 5xx, because it does not know the hop", () => {
    // The 424 downgrade is opt-in per catch site (`mapTargetServerError`). The
    // shared mapper also catches a failed fetch to MCPJam's own Convex
    // deployment and the router-wide `web.onError`, where the hop is unknown —
    // downgrading those would stop paging us during our own outage.
    expect(mapRuntimeError(new Error("fetch failed")).status).toBe(502);
  });

  it("frames the connection class as a target-server problem, preserving the raw error", () => {
    // The raw errno text ("read ECONNRESET") in a client toast reads like an
    // MCPJam outage; the mapped message must name the target server as the
    // failing side while keeping the raw error for debugging.
    const mapped = mapRuntimeError(new Error("read ECONNRESET"));
    expect(mapped.status).toBe(502);
    expect(mapped.code).toBe(ErrorCode.SERVER_UNREACHABLE);
    expect(mapped.message).toContain("read ECONNRESET");
    expect(mapped.message).toContain("not an MCPJam outage");
  });

  it("keeps timeout precedence and handles a null throw", () => {
    // The timeout branch runs BEFORE the connection branch, so a message that
    // satisfies both stays a 504 — the connection downgrade must not capture
    // it. And a non-Error throw still has to land on the stable fallback.
    expect(mapRuntimeError(new Error("Connection timed out")).status).toBe(504);

    const mapped = mapRuntimeError(null);
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it("never returns a blank message for a blank-message error", () => {
    // A bare `new Error()` rejection maps to a blank body message, which the
    // client renders as an empty toast.
    const mapped = mapRuntimeError(new Error(""));
    expect(mapped.status).toBe(500);
    expect(mapped.message.trim()).not.toBe("");
  });

  it("does NOT misclassify words that merely start with 'econ' as 502", () => {
    // Regression for code-review feedback: the errno branch was originally
    // `\becon[a-z]*` (one `n`), which matches server/tool/case names like
    // "Economics" and re-introduces the same kind of false 502 mapping the
    // fix was meant to eliminate. Require the full `econn` prefix.
    expect(
      mapRuntimeError(new Error("Economics server returned an error")).status,
    ).toBe(500);
    expect(mapRuntimeError(new Error("econometric pipeline")).status).toBe(500);
  });

  it("does NOT misclassify 'Reconnect' as 502", () => {
    // Regression: the previous implementation matched the bare substring
    // "connect", which caught the word "Reconnect" inside upstream errors
    // like the eval-generation attachment guard and surfaced them as 502
    // SERVER_UNREACHABLE.
    const error = new Error(
      "Tool snapshot is missing servers required by the attachment: " +
        "Excalidraw (App). Reconnect the missing server(s) in the inspector " +
        "and try again.",
    );
    const mapped = mapRuntimeError(error);
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it("falls back to 500 for unrecognized errors", () => {
    const mapped = mapRuntimeError(new Error("Something else went wrong"));
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBe(ErrorCode.INTERNAL_ERROR);
  });

  it("maps a SEP-2350 insufficient_scope challenge to 403 FORBIDDEN with details.insufficientScope", () => {
    // A live hosted MCP request that 403s `insufficient_scope` surfaces as an
    // `InsufficientScopeError`. It carries no numeric status, so without the
    // dedicated branch it would fall through to the generic 500 and the
    // client would never see the challenge fields.
    const mapped = mapRuntimeError(
      new InsufficientScopeError({
        requiredScope: "read write admin",
        resourceMetadataUrl:
          "https://rs.example/.well-known/oauth-protected-resource",
      }),
    );
    expect(mapped.status).toBe(403);
    expect(mapped.code).toBe(ErrorCode.FORBIDDEN);
    expect(mapped.details?.insufficientScope).toEqual({
      requiredScope: "read write admin",
      resourceMetadataUrl:
        "https://rs.example/.well-known/oauth-protected-resource",
      errorDescription: undefined,
    });
    // Regression guard for the generic upstream-auth branch added below it:
    // `InsufficientScopeError` is also an auth rejection, so it would be
    // swallowed as UPSTREAM_AUTH_FAILED (dropping the challenge the client
    // needs to drive the step-up) if that branch ever moved ahead of this one.
    expect(mapped.code).not.toBe(ErrorCode.UPSTREAM_AUTH_FAILED);
  });

  it("recognizes a wrapped insufficient_scope challenge (cause chain) as 403", () => {
    const inner = new InsufficientScopeError({ requiredScope: "read:tickets" });
    const outer = new Error("tool call failed");
    (outer as any).cause = inner;
    const mapped = mapRuntimeError(outer);
    expect(mapped.status).toBe(403);
    expect(mapped.code).toBe(ErrorCode.FORBIDDEN);
    expect((mapped.details?.insufficientScope as any)?.requiredScope).toBe(
      "read:tickets",
    );
  });

  it("stamps the ORIGINAL error, not only the WebRouteError it built", () => {
    // The mapper constructs a fresh `WebRouteError` and links the original as
    // its `cause`, but the dedupe walk only goes that direction. Several
    // handlers keep their own reference and call `logger.error(error)` after
    // returning the envelope; without a stamp on the original that is a second
    // Sentry event for one failure.
    const original = new Error("kaboom");
    mapRuntimeError(original);

    expect(isOriginCaptureHandled(original)).toBe(true);
  });

  it("keeps the stamp non-enumerable so it never reaches a JSON body", () => {
    const original = new Error("kaboom");
    mapRuntimeError(original);

    expect(Object.keys(original)).not.toContain("cause");
    expect(
      Object.getOwnPropertySymbols(original).filter(
        (s) => original.propertyIsEnumerable(s),
      ),
    ).toEqual([]);
  });
});

/**
 * A connect failure as `MCPClientManager` actually raises it. The quoted
 * server id is the part that matters: it is how a target-server failure is
 * told apart from an MCPJam-internal one inside the same route catch.
 */
const TARGET_CONNECT_FAILURE =
  'Failed to connect to MCP server "srv-1" using HTTP transports. Streamable HTTP error: fetch failed. SSE error: fetch failed.';

describe("mapTargetServerError", () => {
  it("downgrades the connection class out of the 5xx range", () => {
    // The range is the load-bearing part, not the digits: Cloudflare replaces
    // an origin 5xx with its own error page, discarding the JSON envelope and
    // the `x-mcpjam-error-origin` header, and the chat client then reports a
    // user's unreachable MCP server as an MCPJam outage. A later "more
    // specific" 5xx would silently restore that.
    const mapped = mapTargetServerError(new Error(TARGET_CONNECT_FAILURE));
    expect(mapped.status).toBe(424);
    expect(mapped.status).toBeGreaterThanOrEqual(400);
    expect(mapped.status).toBeLessThan(500);
    expect(mapped.code).toBe(ErrorCode.SERVER_UNREACHABLE);
  });

  it("keeps an MCPJam-internal fetch failure at 502", () => {
    // The hosted chat turn's catch spans more than its MCP work: it also
    // covers `/stream/org/resolve`, which is OUR Convex deployment reached
    // with a bare `fetch`. undici raises `TypeError("fetch failed")` with no
    // server named. Downgrading that would silence the page during a Convex
    // outage and tell the user their own server was down — both wrong, and
    // the second one is the exact misattribution this whole change removes.
    const mapped = mapTargetServerError(new Error("fetch failed"));
    expect(mapped.status).toBe(502);
    expect(mapped.code).toBe(ErrorCode.SERVER_UNREACHABLE);
  });

  it("keeps an internal errno failure at 502 too", () => {
    // Same boundary, different symptom: a refused socket to an internal
    // service names no server either.
    expect(
      mapTargetServerError(new Error("connect ECONNREFUSED 10.0.0.4:3210"))
        .status,
    ).toBe(502);
  });

  it("preserves the message, normalized block and origin the shared mapper attached", () => {
    // The status is mutated on the mapped error rather than rebuilt: a fresh
    // `WebRouteError` would drop `origin`, `normalized` and the cause link the
    // capture dedupe walks — and `origin` is what the response header carries.
    const mapped = mapTargetServerError(
      new Error('Failed to connect to MCP server "srv-1": read ECONNRESET'),
    );
    expect(mapped.status).toBe(424);
    expect(mapped.message).toContain("read ECONNRESET");
    expect(mapped.message).toContain("not an MCPJam outage");
    expect(mapped.normalized).toBeDefined();
    expect(mapped.origin).toBe(originOf(mapped.normalized!));
  });

  it("downgrades a TARGET timeout too", () => {
    // `classifyRuntimeError` tests "timed out" BEFORE the connection patterns,
    // so a server that accepts the connection and then goes quiet — an
    // overloaded or half-deployed one — exits as a 504 and never reaches the
    // 502 branch. Cloudflare eats a 504 exactly as it eats a 502, so leaving
    // this class behind kept the misattribution alive one branch over.
    const mapped = mapTargetServerError(
      new Error(
        'Failed to connect to MCP server "srv-1" using HTTP transports: the request timed out',
      ),
    );
    expect(mapped.status).toBe(424);
    expect(mapped.code).toBe(ErrorCode.TIMEOUT);
  });

  it.each([
    // The wrapper the manager actually builds, with the timeout text buried in
    // one transport's leg. This is the realistic shape and the dangerous one:
    // it is a CONNECT failure by structure and a TIMEOUT by substring, and the
    // substring wins — so it never looks like the connection class at all.
    'Failed to connect to MCP server "srv-1" using HTTP transports. Streamable HTTP error: Request timed out. SSE error: Request timed out.',
    // Auto-negotiation probing the modern era before either transport is up.
    'Failed to connect to MCP server "srv-1" using HTTP transports. Streamable HTTP error: Version negotiation probe timed out. SSE error: fetch failed.',
    // Only the SSE leg times out; the first leg failed some other way.
    'Failed to connect to MCP server "srv-1" using HTTP transports. Streamable HTTP error: fetch failed. SSE error: the operation timed out.',
  ])("downgrades a connect failure carrying timeout text: %s", (message) => {
    expect(mapTargetServerError(new Error(message)).status).toBe(424);
  });

  it("keeps an MCPJam-internal timeout at 504", () => {
    // The trade that makes the line above safe. Silence is weaker evidence
    // than a refusal — it can be our own container starving rather than their
    // server being slow — so only a timeout that NAMES the server it was
    // reaching is downgraded. Ours keeps its 5xx and keeps paging.
    expect(mapTargetServerError(new Error("Connection timed out")).status).toBe(
      504,
    );
    expect(
      mapTargetServerError(new Error("Convex request timed out after 10000ms"))
        .status,
    ).toBe(504);
  });

  it("touches ONLY the dependency classes", () => {
    // Everything else is either not a dependency failure or not ours to
    // relabel: auth rejections stay where the spec puts them, and an internal
    // error stays a 500 so it keeps paging — even when a server is named,
    // since naming one does not make an unclassified throw theirs.
    expect(mapTargetServerError(new Error("kaboom")).status).toBe(500);
    expect(
      mapTargetServerError(new Error('MCP server "srv-1" broke us: kaboom'))
        .status,
    ).toBe(500);
  });

  it("leaves a pre-built WebRouteError alone", () => {
    // A route that already decided its own status — including a deliberate
    // 502 for an internal hop — passes through `mapRuntimeError` untouched,
    // and this wrapper must not second-guess it.
    const explicit = new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      "Convex is unreachable",
    );
    expect(mapTargetServerError(explicit).status).toBe(502);
  });
});

describe("ownership inference", () => {
  beforeEach(() => captureException.mockClear());

  it("does NOT infer MCPJam ownership from a native error type", () => {
    // Tempting, and wrong here. This mapper is a SHARED envelope: a TypeError
    // raised while reading a malformed tool result from somebody else's MCP
    // server is indistinguishable from one raised by our own bug, and paging
    // on the pair is the failure mode this change removes. Ownership is
    // DECLARED by a catch-site that knows the hop, never inferred here.
    mapRuntimeError(
      new TypeError("Cannot read properties of undefined (reading 'id')"),
    );

    expect(captureException).not.toHaveBeenCalled();
  });

  it("leaves an ordinary user-server failure uncaptured", () => {
    mapRuntimeError(new Error("Request timed out"));

    expect(captureException).not.toHaveBeenCalled();
  });

  it("still measures the declined failure's origin on the envelope", () => {
    // Not paging is not the same as not recording: the `ambiguous` bucket
    // stays visible in Axiom, which is what makes promoting it later a data
    // decision rather than another guess.
    const mapped = mapRuntimeError(new TypeError("fetch failed"));

    expect(mapped.normalized?.slug).toBe("transport/fetch_failed");
    expect(originOf(mapped.normalized)).toBe("ambiguous");
  });
});

describe("webError origin header", () => {
  function respondWith(error: unknown) {
    const app = new Hono();
    app.get("/boom", (c) => webErrorFromRoute(c, mapRuntimeError(error)));
    return app.request("/boom");
  }

  it("emits the origin as a header, not only in the body", async () => {
    // The chat client's reporter runs AFTER the AI SDK has consumed the
    // Response into `new Error(await response.text())`. Only the status
    // survives to it, and from a bare 5xx it would guess `mcpjam` and page us
    // for a user's own MCP server.
    const res = await respondWith(
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), {
        code: "ECONNREFUSED",
      }),
    );

    expect(res.headers.get("x-mcpjam-error-origin")).toBe("user_config");
    expect((await res.json()).origin).toBe("user_config");
  });

  it("agrees with the body on every envelope that carries one", async () => {
    const res = await respondWith(new Error("kaboom"));

    expect(res.headers.get("x-mcpjam-error-origin")).toBe(
      (await res.json()).origin,
    );
  });
});

/**
 * The one direction of the hop change that must stay impossible.
 *
 * `hop` and `origin` are orthogonal: a hop names WHICH BOUNDARY broke, an
 * origin names WHOSE PROBLEM it is. The monitor predicate lets a
 * `user_server_hop` exclude a row, so if a declaration could ever lower a
 * positively-MCPJam verdict, declaring the hop on the highest-traffic catch in
 * the server would silence real MCPJam outages — the exact failure the origin
 * program exists to prevent, arriving through the fix for it.
 *
 * These drive the real `mapRuntimeError` promotion and the real
 * `webErrorFromRoute`, not a stub: the invariant lives in how those two
 * compose, and a stubbed origin would assert nothing.
 */
describe("a declared hop never lowers an origin", () => {
  async function respondWith(error: unknown, hop: string) {
    const app = new Hono();
    let meta: Record<string, unknown> | undefined;
    app.get("/boom", (c) => {
      const res = webErrorFromRoute(
        c,
        // A boundary the caller owns every throw reaching — how a catch site
        // says "this hop was ours" through the real promotion path.
        mapRuntimeError(error, { boundary: "mcpjam_internal" }),
        { hop },
      );
      meta = c.get("webErrorMeta") as Record<string, unknown> | undefined;
      return res;
    });
    const res = await app.request("/boom");
    return { res, meta, body: (await res.json()) as Record<string, unknown> };
  }

  it("keeps origin=mcpjam on a failure declared user_server_hop", async () => {
    const { meta, body, res } = await respondWith(
      new Error("kaboom"),
      "user_server_hop",
    );

    // The verdict survives on all three surfaces a consumer can read.
    expect(meta?.origin).toBe("mcpjam");
    expect(body.origin).toBe("mcpjam");
    expect(res.headers.get("x-mcpjam-error-origin")).toBe("mcpjam");
    // Recorded beside it, not instead of it.
    expect(meta?.hop).toBe("user_server_hop");
  });

  it("never ships hop in the response envelope", async () => {
    // Telemetry, not client contract. Left in the extras spread it would
    // become a response FIELD, the same trap `responseHeaders` is
    // destructured out for.
    const { body } = await respondWith(new Error("kaboom"), "user_server_hop");

    expect(body.hop).toBeUndefined();
    expect("hop" in body).toBe(false);
  });
});

describe("protocol version pin status", () => {
  /**
   * `ProtocolVersionPinUnsupported` as the SDK raises it. Note what it does
   * NOT contain: no errno, no "fetch failed", no "refused", no "timed out".
   * Writing a message a person can read is what moved this class out of every
   * branch the mapper keys on wording.
   */
  const PIN_FAILURE =
    'MCP server "champions" doesn\'t support MCP protocol version 2026-07-28, which this client is pinned to.';

  it("answers 4xx so the edge cannot eat it", () => {
    // The range is the load-bearing part. Cloudflare replaces an origin 5xx
    // with its own error page, discarding both the sentence that names the
    // version and the `x-mcpjam-error-origin` header — so the browser sees a
    // bare 5xx and reports the user's own configuration as an MCPJam outage.
    const mapped = mapRuntimeError(new Error(PIN_FAILURE));

    expect(mapped.status).toBe(424);
    expect(mapped.status).toBeGreaterThanOrEqual(400);
    expect(mapped.status).toBeLessThan(500);
  });

  it("does not fall through to the 500 catch-all", () => {
    // The regression this exists to catch: with the slug branch removed, this
    // message matches nothing and lands on `500 INTERNAL_ERROR`, which is
    // exactly where it sat when the class was first introduced.
    expect(mapRuntimeError(new Error(PIN_FAILURE)).code).not.toBe(
      ErrorCode.INTERNAL_ERROR,
    );
  });

  it("keeps the message and the slug intact", () => {
    // The status is the only thing this branch changes; the sentence is what
    // the chat banner and the server card both read.
    const mapped = mapRuntimeError(new Error(PIN_FAILURE));

    expect(mapped.message).toContain("2026-07-28");
    expect(mapped.normalized?.slug).toBe("sdk/protocol_version_pin_unsupported");
    // `user_config`, so it never reaches a paging bucket on the server side
    // either — the status fix and the origin fix have to agree.
    expect(originOf(mapped.normalized)).toBe("user_config");
  });
});
