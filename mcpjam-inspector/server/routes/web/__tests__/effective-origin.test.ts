import { describe, expect, it, vi } from "vitest";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

import { originOf } from "@mcpjam/sdk";
import { reportRouteFailure } from "../../../utils/route-error-report.js";
import {
  ErrorCode,
  WebRouteError,
  mapRuntimeError,
  webErrorFromRoute,
} from "../errors.js";

/**
 * The effective origin must survive from the capture decision all the way to
 * `webErrorMeta`, which is what `http.request.failed` reads.
 *
 * Before this, `webError` recomputed `originOf(normalized)` at serialization
 * time — the DECLARED catalog value. A failure reported through an
 * `mcpjam_internal` boundary is promoted to `mcpjam` and pages Sentry, but its
 * catalog slug is usually `ambiguous`, so the Axiom row said `ambiguous` for a
 * failure we had just paged ourselves for. That drift is why `origin=mcpjam`
 * never appeared in 30 days of production data, and why the MCPJam-fault
 * monitor had nothing to gate on.
 */
function fakeContext() {
  const vars: Record<string, unknown> = {};
  return {
    set: (k: string, v: unknown) => {
      vars[k] = v;
    },
    json: (body: unknown, status: number, headers?: Record<string, string>) => ({
      body,
      status,
      headers,
    }),
    vars,
  };
}

describe("effective origin propagation", () => {
  it("carries the promoted origin from mapRuntimeError onto the error", () => {
    // A generic internal failure: the catalog cannot classify it, so it
    // resolves `internal/unknown` -> declared `ambiguous`.
    const routeError = mapRuntimeError(new TypeError("x is not a function"));
    expect(originOf(routeError.normalized)).toBe("ambiguous");
    // Nothing declared an internal boundary here, so effective === declared.
    expect(routeError.origin).toBe("ambiguous");
  });

  it("reports the EFFECTIVE origin in webErrorMeta, not the declared one", () => {
    // Reproduce the drift: a route reports through an internal boundary, which
    // promotes an ambiguous catalog result to `mcpjam`.
    const raw = new TypeError("cannot read properties of undefined");
    const { normalized, origin } = reportRouteFailure("internal blew up", raw, {
      source: "test.internal",
      hop: "mcpjam_internal",
    });
    expect(origin).toBe("mcpjam");
    // The declared catalog value disagrees — this is the whole bug.
    expect(originOf(normalized)).toBe("ambiguous");

    const routeError = new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "internal blew up",
      undefined,
      normalized,
    );
    routeError.origin = origin;

    const c = fakeContext();
    webErrorFromRoute(c as never, routeError);

    expect((c.vars.webErrorMeta as { origin?: string }).origin).toBe("mcpjam");
  });

  it("puts the effective origin on the response body and header too", () => {
    const raw = new TypeError("boom");
    const { normalized, origin } = reportRouteFailure("boom", raw, {
      source: "test.internal",
      hop: "mcpjam_internal",
    });
    const routeError = new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "boom",
      undefined,
      normalized,
    );
    routeError.origin = origin;

    const c = fakeContext();
    const res = webErrorFromRoute(c as never, routeError) as unknown as {
      body: { origin?: string };
      headers?: Record<string, string>;
    };

    // The header matters independently: the AI SDK consumes the Response into
    // `new Error(await response.text())`, so the chat client's reporter sees
    // only status unless the attribution rides in a header.
    expect(res.body.origin).toBe("mcpjam");
    expect(res.headers?.["x-mcpjam-error-origin"]).toBe("mcpjam");
  });

  it("falls back to the declared origin when nothing made a capture decision", () => {
    // A hand-built WebRouteError that never went through mapRuntimeError has no
    // effective origin. The declared value is then the best available answer,
    // and must still be reported rather than dropped.
    const routeError = mapRuntimeError(
      new Error("connect ECONNREFUSED 127.0.0.1:8080"),
    );
    const declared = originOf(routeError.normalized);
    routeError.origin = undefined;

    const c = fakeContext();
    webErrorFromRoute(c as never, routeError);

    expect((c.vars.webErrorMeta as { origin?: string }).origin).toBe(declared);
    expect(declared).toBe("user_config");
  });

  it("does not promote a failure with positive user-server evidence", () => {
    // The boundary declaration must never overrule real evidence: an
    // ECONNREFUSED that reached an internal hop is still the user's config.
    const { origin } = reportRouteFailure(
      "refused",
      new Error("connect ECONNREFUSED 127.0.0.1:8080"),
      { source: "test.internal", hop: "mcpjam_internal" },
    );
    expect(origin).toBe("user_config");
  });
});
