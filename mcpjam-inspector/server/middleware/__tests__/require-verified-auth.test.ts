import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { requireVerifiedAuth } from "../require-verified-auth.js";
import {
  AuthKitConfigError,
  AuthKitVerificationError,
} from "../../services/authkit-jwt.js";

/**
 * The gate for v1 routes that never call Convex.
 *
 * `bearerAuthMiddleware` lets an unrecognized bearer through unverified,
 * because almost every v1 route forwards it to Convex, which does verify it.
 * For the two routes that DON'T forward it — `GET /agent-ops` and
 * `GET /harness/:id/builtin-tools` — reaching the handler IS the
 * authorization, so `Authorization: Bearer anything` would read them.
 *
 * What these pin, in order:
 *   1. An unverified passthrough with a bad token is 401.
 *   2. An identity already established upstream (sk_ key, service token,
 *      guest) passes WITHOUT a second verification — otherwise mounting this
 *      would break every non-JWT caller.
 *   3. AuthKit not configured at all (OSS/self-hosted) passes. This is the
 *      only reason a verification path may fail open, and it is narrow: an
 *      AuthKitConfigError, never a verification failure.
 */

function appWith(
  verify: ReturnType<typeof vi.fn>,
  seed?: (c: { set: (k: string, v: unknown) => void }) => void
) {
  const app = new Hono();
  if (seed) {
    app.use("*", async (c, next) => {
      seed(c);
      return next();
    });
  }
  app.use("*", requireVerifiedAuth({ verify: verify as never }));
  app.get("/probe", (c) => c.json({ ok: true }));
  // Real v1 paths, so the guest cases below exercise the actual allowlist
  // patterns rather than a stand-in.
  app.get("/api/v1/projects", (c) => c.json({ ok: true }));
  app.get("/api/v1/agent-ops", (c) => c.json({ ok: true }));
  return app;
}

function get(app: Hono, token: string | null = "some-jwt") {
  return app.request("/probe", {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

describe("requireVerifiedAuth", () => {
  it("verifies an unverified passthrough bearer and lets a good one through", async () => {
    const verify = vi.fn().mockResolvedValue({ sub: "workos|alice" });
    const app = appWith(verify, (c) =>
      c.set("authMethod", "unverified_passthrough")
    );

    const res = await get(app);
    expect(res.status).toBe(200);
    expect(verify).toHaveBeenCalledWith("some-jwt");
  });

  it("401s a bearer that fails verification — this is the hole it closes", async () => {
    const verify = vi
      .fn()
      .mockRejectedValue(new AuthKitVerificationError("bad signature"));
    const app = appWith(verify, (c) =>
      c.set("authMethod", "unverified_passthrough")
    );

    const res = await get(app, "not-a-real-jwt");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code?: string }).code).toBe("UNAUTHORIZED");
  });

  it("401s when there is no bearer at all", async () => {
    // Unreachable behind `bearerAuthMiddleware`, which 401s first. Pinned so
    // the middleware is safe to mount anywhere rather than correct only in one
    // arrangement.
    const verify = vi.fn();
    const res = await get(appWith(verify), null);
    expect(res.status).toBe(401);
    expect(verify).not.toHaveBeenCalled();
  });

  it.each(["workos_api_key", "slack_service", "discord_service"] as const)(
    "passes %s through untouched — it was already established upstream",
    async (authMethod) => {
      const verify = vi.fn();
      const app = appWith(verify, (c) => c.set("authMethod", authMethod));

      expect((await get(app)).status).toBe(200);
      expect(verify).not.toHaveBeenCalled();
    }
  );

  /**
   * A guest is admitted only where guests are allowed, decided HERE.
   *
   * The `v1.use("*")` deny in `routes/v1/index.ts` reaches the same verdict and
   * runs first, so today this changes no behavior. It is enforced here anyway
   * because "correct because of mount order" does not survive reuse: mount this
   * middleware on another router, or refactor that deny, and a validated guest
   * token would otherwise walk into a route whose whole point is that it is
   * authenticated-only.
   */
  describe("guests", () => {
    it("passes on a guest-ALLOWED path, without a second verification", async () => {
      const verify = vi.fn();
      // On the platform-tool allowlist (`GET /projects`).
      const app = appWith(verify, (c) => c.set("guestId", "guest_1"));

      const res = await app.request("/api/v1/projects", {
        headers: { Authorization: "Bearer some-jwt" },
      });
      expect(res.status).toBe(200);
      expect(verify).not.toHaveBeenCalled();
    });

    it("is 401 on a guest-DENIED path, on its own rule", async () => {
      const verify = vi.fn();
      // `/agent-ops` is not on the allowlist — it is one of the two routes this
      // middleware exists for.
      const app = appWith(verify, (c) => c.set("guestId", "guest_1"));

      const res = await app.request("/api/v1/agent-ops", {
        headers: { Authorization: "Bearer some-jwt" },
      });
      expect(res.status).toBe(401);
      // Denied as a guest, not sent off to AuthKit: a guest token is not a
      // WorkOS JWT and verifying it would only fail slower.
      expect(verify).not.toHaveBeenCalled();
    });
  });

  it("passes everyone through when AuthKit is not configured — the OSS install has no identity system to protect", async () => {
    const verify = vi
      .fn()
      .mockRejectedValue(new AuthKitConfigError("WORKOS_CLIENT_ID is not set"));
    const app = appWith(verify, (c) =>
      c.set("authMethod", "unverified_passthrough")
    );

    expect((await get(app)).status).toBe(200);
  });

  it("does NOT fail open on a generic error — only AuthKitConfigError takes that branch", async () => {
    const verify = vi.fn().mockRejectedValue(new Error("JWKS fetch failed"));
    const app = appWith(verify, (c) =>
      c.set("authMethod", "unverified_passthrough")
    );

    expect((await get(app)).status).toBe(401);
  });
});
