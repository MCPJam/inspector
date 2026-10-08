import { afterEach, describe, expect, it, vi } from "vitest";
import { WebRouteError } from "../../routes/web/errors.js";
import {
  upstreamRefusalFromResponse,
  upstreamRefusalRouteError,
} from "../upstream-refusal.js";
import { generateTestCases } from "../eval-agent";
import { generateNegativeTestCases } from "../negative-test-agent";
import type { ServerToolSnapshot } from "../../utils/export-helpers";

const SNAPSHOT = { version: 1, servers: [] } as unknown as ServerToolSnapshot;

/**
 * The new refusal PR #1412 adds: MCPJam's own daily budget for the feature is
 * spent. Retryable once the UTC day rolls, and `canTopUp: false` because this
 * is not the customer's allowance — there is nothing for them to buy.
 */
const PLATFORM_CAPACITY_BODY = {
  ok: false,
  code: "platform_capacity",
  error: "MCPJam's daily generation budget is used up. Try again after 00:00 UTC.",
  isRetryable: true,
  retryAfterMs: 3_600_000,
  canTopUp: false,
};

function refusal(
  body: unknown,
  status: number,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
  });
}

function stubFetch(response: Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => response) as unknown as typeof fetch,
  );
}

describe("upstreamRefusalRouteError", () => {
  it("preserves a 429, its code and its Retry-After header", () => {
    const routeError = upstreamRefusalRouteError({
      status: 429,
      bodyText: JSON.stringify(PLATFORM_CAPACITY_BODY),
      fallbackMessage: "Generation failed (429).",
      retryAfter: "60",
    });
    expect(routeError?.status).toBe(429);
    expect(routeError?.code).toBe("RATE_LIMITED");
    expect(routeError?.message).toBe(PLATFORM_CAPACITY_BODY.error);
    expect(routeError?.details).toMatchObject({ code: "platform_capacity" });
    expect(routeError?.headers).toEqual({ "Retry-After": "60" });
  });

  it("derives Retry-After from retryAfterMs when the header is absent", () => {
    const routeError = upstreamRefusalRouteError({
      status: 429,
      // 1500ms rounds UP: a client retrying at `floor` comes back inside the
      // window and is refused a second time.
      bodyText: JSON.stringify({ ok: false, retryAfterMs: 1_500 }),
      fallbackMessage: "Generation failed (429).",
    });
    expect(routeError?.headers).toEqual({ "Retry-After": "2" });
  });

  it("keeps a 403 model gate at 403 rather than normalizing every refusal", () => {
    const routeError = upstreamRefusalRouteError({
      status: 403,
      bodyText: JSON.stringify({
        ok: false,
        code: "free_tier_model_restricted",
        error: "That model is not on the free allowance.",
      }),
      fallbackMessage: "Generation failed (403).",
    });
    expect(routeError?.status).toBe(403);
    expect(routeError?.code).toBe("FORBIDDEN");
    expect(routeError?.details).toMatchObject({
      code: "free_tier_model_restricted",
    });
  });

  it("contributes no details for a body that is not a refusal envelope", () => {
    // A WAF interstitial or proxy error page. Forwarding it would put an
    // arbitrary upstream string on our wire under a `details` key clients read.
    const routeError = upstreamRefusalRouteError({
      status: 429,
      bodyText: "<html><body>Access denied</body></html>",
      fallbackMessage: "Generation failed (429).",
    });
    expect(routeError?.status).toBe(429);
    expect(routeError?.details).toBeUndefined();
    expect(routeError?.message).toBe("Generation failed (429).");
  });

  it("declines anything outside 4xx, leaving 5xx to its caller", () => {
    expect(
      upstreamRefusalRouteError({
        status: 502,
        bodyText: JSON.stringify({ ok: false, code: "provider_error" }),
        fallbackMessage: "Generation failed (502).",
      }),
    ).toBeUndefined();
  });
});

describe("upstreamRefusalFromResponse", () => {
  it("prefers the upstream Retry-After header over the body field", async () => {
    const error = await upstreamRefusalFromResponse(
      refusal(PLATFORM_CAPACITY_BODY, 429, { "Retry-After": "900" }),
      "Failed to generate test cases",
    );
    expect(error).toBeInstanceOf(WebRouteError);
    expect((error as WebRouteError).headers).toEqual({ "Retry-After": "900" });
  });

  it("leaves a 5xx as a plain Error carrying the flattened body", async () => {
    const error = await upstreamRefusalFromResponse(
      refusal({ ok: false, code: "provider_error" }, 503),
      "Failed to generate test cases",
    );
    expect(error).not.toBeInstanceOf(WebRouteError);
    expect(error.message).toContain("Failed to generate test cases");
    expect(error.message).toContain("provider_error");
  });
});

describe("eval generation adapters forward backend refusals", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    [
      "generateTestCases",
      () => generateTestCases(SNAPSHOT, "https://convex.test", "tok"),
    ],
    [
      "generateNegativeTestCases",
      () => generateNegativeTestCases(SNAPSHOT, "https://convex.test", "tok"),
    ],
  ])(
    "%s turns a platform_capacity 429 into a 429, not a 500",
    async (_label, run) => {
      stubFetch(refusal(PLATFORM_CAPACITY_BODY, 429, { "Retry-After": "120" }));
      // `rejects.toThrow` would only see the message, and the message was never
      // the bug — the STATUS was. Catch the error and assert the envelope.
      const error = await run().then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(WebRouteError);
      const routeError = error as WebRouteError;
      expect(routeError.status).toBe(429);
      expect(routeError.code).toBe("RATE_LIMITED");
      expect(routeError.details).toMatchObject({ code: "platform_capacity" });
      expect(routeError.headers).toEqual({ "Retry-After": "120" });
    },
  );

  it.each([
    [
      "generateTestCases",
      () => generateTestCases(SNAPSHOT, "https://convex.test", "tok"),
    ],
    [
      "generateNegativeTestCases",
      () => generateNegativeTestCases(SNAPSHOT, "https://convex.test", "tok"),
    ],
  ])("%s leaves an upstream 5xx unclassified", async (_label, run) => {
    stubFetch(refusal({ ok: false, code: "provider_error" }, 500));
    const error = await run().then(
      () => undefined,
      (err: unknown) => err,
    );
    // Not a WebRouteError: the runtime classifier still owns this, so each
    // surface keeps whatever 5xx treatment (and masking) it already applied.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WebRouteError);
  });
});
