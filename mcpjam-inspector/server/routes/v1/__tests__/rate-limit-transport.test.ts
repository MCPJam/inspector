/**
 * The 429 transport: does a refusal keep its status AND its `Retry-After` from
 * the backend mutation that raised it all the way to the caller?
 *
 * Everything here is about one gap. The published spec `$ref`s `RateLimited`
 * — which documents `Retry-After` — from 87 of its 88 operations, and until
 * this work only ONE code path in the product could honor it: the `sk_` branch
 * of the bearer middleware, which builds its own `c.json` and never touches the
 * v1 envelope. Every other 429 promised a header it had no channel to send:
 * `WebRouteError` had no headers field, `mapErrorToV1` returned a bare
 * `{code,message,details}`, and `v1Error` called the two-argument `c.json`.
 *
 * These tests deploy AHEAD of any producer of the new refusal codes, so they
 * pin the transport with stubbed errors rather than real limiters. That
 * ordering is the point: a producer shipped before this transport would spend
 * the whole mixed-version window flattening throttles into 400s, telling
 * clients to fix a request that was fine.
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { translateConvexWriteError } from "../convex-errors.js";
import { mapErrorToV1, v1Error, v1OnError } from "../envelope.js";
import { ErrorCode, WebRouteError } from "../../web/errors.js";
import {
  SwarmAgentError,
  upstreamRetryAfter,
} from "../../../services/swarm-agent.js";

/** A Convex application error as it arrives over the wire: `data` is the bag. */
function convexError(data: Record<string, unknown>): Error {
  return Object.assign(new Error(String(data.message ?? "refused")), { data });
}

describe("translateConvexWriteError — rate_limited (the burst brake)", () => {
  it("answers 429 with the measured wait, not the terminal 500", () => {
    // Without the branch this code falls past every recognized outcome into
    // the unrecognized-failure 500 — a refusal we deliberately raised,
    // reported as our own bug and paged for.
    const error = translateConvexWriteError(
      convexError({
        code: "rate_limited",
        message: "Too many launches. Slow down and retry.",
        retryAfterMs: 12_000,
      }),
      { resource: "Journey run" }
    );

    expect(error.status).toBe(429);
    expect(error.code).toBe(ErrorCode.RATE_LIMITED);
    expect(error.message).toBe("Too many launches. Slow down and retry.");
    expect(error.details).toMatchObject({ retryAfterMs: 12_000 });
    expect(error.headers).toMatchObject({ "Retry-After": "12" });
  });

  it("rounds the wait UP, so the header never under-advises", () => {
    const error = translateConvexWriteError(
      convexError({ code: "rate_limited", retryAfterMs: 1200 }),
      { resource: "Journey run" }
    );

    expect(error.headers).toMatchObject({ "Retry-After": "2" });
  });

  it("still answers 429 when the backend sent no wait at all", () => {
    // A mixed-version backend that knows the code but not the field. The
    // status is the half that changes client behavior; the header is best
    // effort, and inventing one would be a guess presented as measurement.
    const error = translateConvexWriteError(
      convexError({ code: "rate_limited" }),
      { resource: "Journey run" }
    );

    expect(error.status).toBe(429);
    expect(error.headers).toBeUndefined();
  });

  it("refuses to turn junk retry metadata into a header", () => {
    // `undefined` is the honest absence tested above. These are the OTHER
    // absences — a field that arrived but says nothing usable. Each one
    // reaches `Number.isFinite` as something that is not a finite number, and
    // the answer has to be the same as for a missing field: still a 429,
    // still no header. A `Retry-After: NaN` on the wire is worse than none,
    // because a client that parses it gets a number it will happily wait on.
    for (const retryAfterMs of [
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "soon",
      {},
    ]) {
      const error = translateConvexWriteError(
        convexError({ code: "rate_limited", retryAfterMs }),
        { resource: "Journey run" }
      );

      expect(error.status).toBe(429);
      expect(error.headers).toBeUndefined();
    }
  });
});

describe("translateConvexWriteError — billing_limit_reached (the daily cap)", () => {
  it("keeps resetsAt and turns it into Retry-After", () => {
    // `resetsAt` has been documented on this code since it existed and dropped
    // on the floor the whole time, which left "Plan limit reached" as advice a
    // caller could act on only by guessing.
    const now = Date.UTC(2026, 7, 15, 18, 0, 0);
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const resetsAt = Date.UTC(2026, 7, 16, 0, 0, 0); // 6h out

      const error = translateConvexWriteError(
        convexError({
          code: "billing_limit_reached",
          message: 'Limit "insightsPerDay" reached on the free plan.',
          limit: "insightsPerDay",
          plan: "free",
          upgradePlan: "team",
          currentValue: 25,
          allowedValue: 25,
          resetsAt,
        }),
        { resource: "Wave insights" }
      );

      expect(error.status).toBe(429);
      expect(error.details).toMatchObject({
        limit: "insightsPerDay",
        plan: "free",
        upgradePlan: "team",
        currentValue: 25,
        allowedValue: 25,
        resetsAt,
      });
      expect(error.headers).toMatchObject({ "Retry-After": "21600" });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("advertises the floor when the window rolled mid-flight", () => {
    // `resetsAt` in the past means the day rolled between the backend raising
    // this and us serializing it. The caller's next attempt will succeed, and
    // "1" says so more usefully than an omitted header.
    const now = Date.UTC(2026, 7, 16, 0, 0, 5);
    vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const error = translateConvexWriteError(
        convexError({
          code: "billing_limit_reached",
          resetsAt: Date.UTC(2026, 7, 16, 0, 0, 0),
        }),
        { resource: "Wave insights" }
      );

      expect(error.headers).toMatchObject({ "Retry-After": "1" });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("omits the header for a cap with no known reset", () => {
    // A cap that cannot say when it lifts should not invite a timed retry.
    const error = translateConvexWriteError(
      convexError({ code: "billing_limit_reached", limit: "maxProjects" }),
      { resource: "Project" }
    );

    expect(error.status).toBe(429);
    expect(error.details).toMatchObject({ limit: "maxProjects" });
    expect(error.headers).toBeUndefined();
  });
});

describe("the v1 header channel", () => {
  it("mapErrorToV1 carries headers off the WebRouteError", () => {
    const err = new WebRouteError(
      429,
      ErrorCode.RATE_LIMITED,
      "slow down"
    ).withHeaders({ "Retry-After": "30" });

    expect(mapErrorToV1(err)).toMatchObject({
      code: "RATE_LIMITED",
      headers: { "Retry-After": "30" },
    });
  });

  it("v1Error passes them to c.json as the third argument", () => {
    const calls: unknown[][] = [];
    const c = {
      set: () => {},
      get: () => undefined,
      json: (...args: unknown[]) => {
        calls.push(args);
        return {};
      },
    };

    v1Error(c as never, "RATE_LIMITED", "slow down", undefined, {
      "Retry-After": "30",
    });

    expect(calls[0]?.[2]).toEqual({ "Retry-After": "30" });
  });

  it("leaves the third argument undefined when there are none", () => {
    // Several route tests pass a context double whose `json` only accepts two
    // arguments. Handing them `{}` would change behavior on every error path
    // to plumb a header almost none of them carry.
    const calls: unknown[][] = [];
    const c = {
      set: () => {},
      get: () => undefined,
      json: (...args: unknown[]) => {
        calls.push(args);
        return {};
      },
    };

    v1Error(c as never, "NOT_FOUND", "nope");

    expect(calls[0]?.[2]).toBeUndefined();
  });

  it("reaches the wire end to end through v1OnError", async () => {
    const app = new Hono();
    app.onError(v1OnError);
    app.get("/boom", () => {
      throw translateConvexWriteError(
        convexError({
          code: "rate_limited",
          message: "Too many requests.",
          retryAfterMs: 45_000,
        }),
        { resource: "Journey run" }
      );
    });

    const res = await app.request("/boom");

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("45");
    expect(await res.json()).toMatchObject({
      code: "RATE_LIMITED",
      message: "Too many requests.",
      details: { retryAfterMs: 45_000 },
    });
  });

  it("does not disturb an error that carries no headers", async () => {
    const app = new Hono();
    app.onError(v1OnError);
    app.get("/boom", () => {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "no such thing");
    });

    const res = await app.request("/boom");

    expect(res.status).toBe(404);
    expect(res.headers.get("retry-after")).toBeNull();
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("upstreamRetryAfter — what a proxy is willing to forward", () => {
  const withHeader = (value: string) =>
    new Response(null, { status: 429, headers: { "Retry-After": value } });

  it("takes delta-seconds", () => {
    expect(upstreamRetryAfter(withHeader("60"))).toBe("60");
    expect(upstreamRetryAfter(withHeader("  60  "))).toBe("60");
  });

  it("refuses anything that is not delta-seconds", () => {
    // A header we forward blind is a header we let another service set on our
    // response. The RFC also permits an HTTP-date, which no backend producer
    // emits — accepting it would be carrying a format nobody produces.
    expect(
      upstreamRetryAfter(withHeader("Wed, 21 Oct 2026 07:28:00 GMT"))
    ).toBe(undefined);
    expect(upstreamRetryAfter(withHeader("60, 90"))).toBeUndefined();
    expect(upstreamRetryAfter(withHeader("-5"))).toBeUndefined();
    expect(upstreamRetryAfter(withHeader("99999999999"))).toBeUndefined();
  });

  it("is undefined when the upstream sent none", () => {
    expect(upstreamRetryAfter(new Response(null, { status: 429 }))).toBe(
      undefined
    );
  });
});

describe("SwarmAgentError", () => {
  it("carries the upstream Retry-After alongside the status", () => {
    const err = new SwarmAgentError(429, "{}", "refused", "17");

    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe("17");
  });

  it("leaves it undefined for the 4xx shapes that have no wait", () => {
    expect(new SwarmAgentError(404, "{}", "gone").retryAfter).toBeUndefined();
  });
});
