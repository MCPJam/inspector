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

  it("frames connection-class 502s as a target-server problem, preserving the raw error", () => {
    // The raw errno text ("read ECONNRESET") in a client toast reads like an
    // MCPJam outage; the mapped message must name the target server as the
    // failing side while keeping the raw error for debugging.
    const mapped = mapRuntimeError(new Error("read ECONNRESET"));
    expect(mapped.status).toBe(502);
    expect(mapped.code).toBe(ErrorCode.SERVER_UNREACHABLE);
    expect(mapped.message).toContain("read ECONNRESET");
    expect(mapped.message).toContain("not an MCPJam outage");
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
