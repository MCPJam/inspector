import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * WHICH BEARER a v1 route sends to Convex, decided by `authMethod`.
 *
 * There are two shapes of caller and they need opposite treatment. A JWT
 * caller (browser session, guest) already holds a credential Convex verifies,
 * so its bearer is forwarded VERBATIM. A service caller — a `sk_` API key, the
 * Slack bot, the Discord bot — holds something Convex has never heard of, so
 * the gateway mints a short-lived delegated JWT on its behalf.
 *
 * Sending the wrong one fails in two different, both-bad ways: forward a `sk_`
 * and every downstream Convex action 401s; mint for a JWT caller and you have
 * silently swapped a user's own identity for a delegated one.
 *
 * The dispatch used to be spelled out twice — once positively, once negatively
 * — in `getConvexBearerForRequest` and `getConvexBearerThunkForRequest`. Adding
 * a fourth service credential to only one is a silent failure in the direction
 * that matters: the caller still gets a bearer, it just stops REFRESHING
 * partway through a multi-hour run. These pin both functions against the same
 * set so the two cannot disagree.
 */

/**
 * The mint is an HTTP call to Convex's `/web/delegated-token`, so the seam is
 * `fetch`. Counting calls on it also proves the NEGATIVE cases: a JWT caller
 * must not mint at all, and "it returned the right string" would not catch a
 * mint that happened and was discarded.
 */
const mintFetch = vi.fn();

import { afterEach, beforeEach } from "vitest";
import {
  getConvexBearerForRequest,
  getConvexBearerThunkForRequest,
} from "../v1-convex-token.js";

beforeEach(() => {
  mintFetch.mockReset();
  // A FRESH Response per call. A `Response` body reads exactly once, so a
  // single shared instance makes the second mint of a test see an empty body
  // and fail as "exchange failed (200)" — a mock artifact that looks like a
  // real dispatch bug.
  //
  // `ok: true` is part of the contract, not decoration: the mint rejects a 200
  // without it, which is what stops a proxy's HTML error page from being read
  // as a credential.
  mintFetch.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          token: "delegated-jwt",
          // TWO HOURS, not a minute. The cache treats anything inside
          // `EXPIRY_SLACK_MS` (10 min) as due for refresh, so a short-lived
          // mock would re-mint on every call and the test would never exercise
          // the cached hit that the thunk exists to make cheap.
          expiresAt: Date.now() + 2 * 60 * 60 * 1000,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
  );
  vi.stubGlobal("fetch", mintFetch);
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Every method that must take the DELEGATED path. */
const DELEGATED = ["workos_api_key", "slack_service", "discord_service"] as const;

/**
 * Run both entry points against one seeded request and report which bearer
 * each produced, so a disagreement between them shows up as a diff.
 */
async function bearersFor(seed: (c: any) => void) {
  const results: { direct?: string; thunk?: string; error?: string } = {};
  const app = new Hono();
  app.use("*", async (c, next) => {
    seed(c);
    return next();
  });
  app.get("/probe", async (c) => {
    try {
      results.direct = await getConvexBearerForRequest(c);
      results.thunk = await getConvexBearerThunkForRequest(c)();
    } catch (error) {
      results.error = error instanceof Error ? error.message : String(error);
    }
    return c.json({ ok: true });
  });
  await app.request("/probe", {
    headers: { Authorization: "Bearer caller-jwt" },
  });
  return results;
}

describe("v1 Convex bearer dispatch", () => {
  it.each(DELEGATED)("mints a delegated JWT for %s", async (authMethod) => {
    const { direct, thunk, error } = await bearersFor((c) => {
      c.set("authMethod", authMethod);
      // A DISTINCT user per method, so the mint cache (keyed on user+org)
      // cannot serve one method's token to another and hide a dispatch bug.
      c.set("workosUserId", `workos|${authMethod}`);
      c.set("mcpjamOrganizationId", "org_1");
    });

    expect(error).toBeUndefined();
    expect(direct).toBe("delegated-jwt");
    // Both entry points, one answer. This is the assertion that fails if the
    // two dispatches ever drift.
    expect(thunk).toBe(direct);
    // Proves the delegated path was actually TAKEN. Without this the test
    // passes if some future branch returns the right-looking string without
    // exchanging anything. Exactly once: the second call is a cache hit.
    expect(mintFetch).toHaveBeenCalledTimes(1);
  });

  it("forwards the caller's own bearer when the method is NOT delegated", async () => {
    const { direct, thunk, error } = await bearersFor((c) => {
      c.set("authMethod", "unverified_passthrough");
    });

    expect(error).toBeUndefined();
    expect(direct).toBe("caller-jwt");
    expect(thunk).toBe("caller-jwt");
    // And nothing was minted — a JWT caller must keep its own identity.
    expect(mintFetch).not.toHaveBeenCalled();
  });

  it("forwards the caller's own bearer when there is no authMethod at all", async () => {
    const { direct, thunk } = await bearersFor(() => {});

    expect(direct).toBe("caller-jwt");
    expect(thunk).toBe("caller-jwt");
    expect(mintFetch).not.toHaveBeenCalled();
  });
});
