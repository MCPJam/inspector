/**
 * `POST /api/web/auth-session/revoke` — the sign-out hook. The bearer
 * middleware is replaced by a stub that labels the caller from a test header,
 * so each credential class can be driven directly; the Convex call is mocked
 * at the service boundary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { revokeAuthKitSessionMock, eventMock } = vi.hoisted(() => ({
  revokeAuthKitSessionMock: vi.fn(),
  eventMock: vi.fn(),
}));

vi.mock("../../../middleware/bearer-auth.js", () => ({
  bearerAuthMiddleware: async (c: any, next: () => Promise<void>) => {
    const method = c.req.header("x-test-auth-method");
    if (method) c.set("authMethod", method);
    return next();
  },
}));

vi.mock("../../../services/auth-session-revocation.js", () => ({
  revokeAuthKitSession: revokeAuthKitSessionMock,
}));

vi.mock("../../../utils/request-logger.js", () => ({
  getRequestLogger: () => ({ event: eventMock }),
}));

// The passthrough limiter only meters in hosted mode, which is where this
// route serves the AuthKit callers it charges.
vi.mock("../../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config.js")>()),
  HOSTED_MODE: true,
}));

import authSession from "../auth-session.js";
import {
  PASSTHROUGH_TOKEN_LIMIT,
  resetPassthroughRateLimitForTests,
} from "../../../middleware/passthrough-rate-limit.js";

function post(authMethod: string | null, token = "access-token-1") {
  const app = new Hono();
  app.route("/api/web/auth-session", authSession);
  return app.request("/api/web/auth-session/revoke", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(authMethod ? { "x-test-auth-method": authMethod } : {}),
    },
  });
}

beforeEach(() => {
  revokeAuthKitSessionMock.mockReset();
  eventMock.mockReset();
  resetPassthroughRateLimitForTests();
});

describe("POST /api/web/auth-session/revoke", () => {
  it.each(["authkit_jwt", "unverified_passthrough"])(
    "revokes the session of a signed-in %s bearer",
    async (authMethod) => {
      revokeAuthKitSessionMock.mockResolvedValue({ revoked: true });

      const res = await post(authMethod);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revoked: true });
      expect(revokeAuthKitSessionMock).toHaveBeenCalledWith("access-token-1");
    },
  );

  it.each(["guest", "workos_api_key", "slack_service", "discord_service"])(
    "has nothing to revoke for a %s credential",
    async (authMethod) => {
      const res = await post(authMethod);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        revoked: false,
        reason: "not_a_session",
      });
      expect(revokeAuthKitSessionMock).not.toHaveBeenCalled();
    },
  );

  it("still answers 200, and records why, when the backend cannot be reached", async () => {
    revokeAuthKitSessionMock.mockResolvedValue({
      revoked: false,
      reason: "timeout",
    });

    const res = await post("authkit_jwt");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: false, reason: "timeout" });
    expect(eventMock).toHaveBeenCalledWith("auth.session.revoke_incomplete", {
      reason: "timeout",
    });
  });

  it("does not warn when the token simply had no session to revoke", async () => {
    revokeAuthKitSessionMock.mockResolvedValue({
      revoked: false,
      reason: "no_session",
    });

    await post("authkit_jwt");

    expect(eventMock).not.toHaveBeenCalled();
  });

  it("meters a signed-in bearer with the per-credential passthrough budget", async () => {
    revokeAuthKitSessionMock.mockResolvedValue({ revoked: true });
    for (let i = 0; i < PASSTHROUGH_TOKEN_LIMIT; i++) {
      expect((await post("unverified_passthrough", "tok-burst")).status).toBe(
        200,
      );
    }

    const res = await post("unverified_passthrough", "tok-burst");

    expect(res.status).toBe(429);
    expect(revokeAuthKitSessionMock).toHaveBeenCalledTimes(
      PASSTHROUGH_TOKEN_LIMIT,
    );
  });
});
