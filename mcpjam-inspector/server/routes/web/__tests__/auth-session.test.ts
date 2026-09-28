/**
 * `POST /api/web/auth-session/revoke` — the sign-out hook. The bearer
 * middleware is replaced by a stub that labels the caller from a test header,
 * so each credential class can be driven directly; the Convex call is mocked
 * at the service boundary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { revokeSessionMock, eventMock } = vi.hoisted(() => ({
  revokeSessionMock: vi.fn(),
  eventMock: vi.fn(),
}));

vi.mock("../../../middleware/bearer-auth.js", () => ({
  bearerAuthMiddleware: async (c: any, next: () => Promise<void>) => {
    const method = c.req.header("x-test-auth-method");
    if (method) c.set("authMethod", method);
    const sid = c.req.header("x-test-session-id");
    if (sid) c.set("workosSessionId", sid);
    return next();
  },
}));

vi.mock("../../../services/auth-session-revocation.js", () => ({
  revokeSessionWithAcknowledgment: revokeSessionMock,
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

function post(
  authMethod: string | null,
  token = "access-token-1",
  sessionId?: string,
) {
  const app = new Hono();
  app.route("/api/web/auth-session", authSession);
  return app.request("/api/web/auth-session/revoke", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(authMethod ? { "x-test-auth-method": authMethod } : {}),
      ...(sessionId ? { "x-test-session-id": sessionId } : {}),
    },
  });
}

beforeEach(() => {
  revokeSessionMock.mockReset();
  eventMock.mockReset();
  resetPassthroughRateLimitForTests();
});

describe("POST /api/web/auth-session/revoke", () => {
  it.each(["authkit_jwt", "unverified_passthrough"])(
    "revokes the session of a signed-in %s bearer",
    async (authMethod) => {
      revokeSessionMock.mockResolvedValue({ revoked: true });

      const res = await post(authMethod);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ revoked: true });
      expect(revokeSessionMock).toHaveBeenCalledWith("access-token-1", {
        verifiedSid: undefined,
      });
    },
  );

  it("hands over the session id only when the gateway verified it", async () => {
    revokeSessionMock.mockResolvedValue({ revoked: true });

    await post("authkit_jwt", "access-token-1", "session_1");
    await post("unverified_passthrough", "access-token-2", "session_2");

    expect(revokeSessionMock).toHaveBeenNthCalledWith(1, "access-token-1", {
      verifiedSid: "session_1",
    });
    expect(revokeSessionMock).toHaveBeenNthCalledWith(2, "access-token-2", {
      verifiedSid: undefined,
    });
  });

  it.each(["guest", "workos_api_key", "slack_service", "discord_service"])(
    "has nothing to revoke for a %s credential",
    async (authMethod) => {
      const res = await post(authMethod);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        revoked: false,
        reason: "not_a_session",
      });
      expect(revokeSessionMock).not.toHaveBeenCalled();
    },
  );

  it("still answers 200 — as pending, not revoked — when the backend has not acknowledged", async () => {
    revokeSessionMock.mockResolvedValue({
      revoked: false,
      reason: "timeout",
      status: "pending",
    });

    const res = await post("authkit_jwt");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      revoked: false,
      reason: "timeout",
      status: "pending",
    });
    expect(eventMock).toHaveBeenCalledWith("auth.session.revoke_incomplete", {
      reason: "timeout",
      status: "pending",
    });
  });

  it("reports failed when no retry could be scheduled", async () => {
    revokeSessionMock.mockResolvedValue({
      revoked: false,
      reason: "failed",
      status: "failed",
    });

    const res = await post("authkit_jwt");

    expect(await res.json()).toEqual({
      revoked: false,
      reason: "failed",
      status: "failed",
    });
    expect(eventMock).toHaveBeenCalledWith("auth.session.revoke_incomplete", {
      reason: "failed",
      status: "failed",
    });
  });

  it("does not warn when the token simply had no session to revoke", async () => {
    revokeSessionMock.mockResolvedValue({
      revoked: false,
      reason: "no_session",
    });

    await post("authkit_jwt");

    expect(eventMock).not.toHaveBeenCalled();
  });

  it("meters a signed-in bearer with the per-credential passthrough budget", async () => {
    revokeSessionMock.mockResolvedValue({ revoked: true });
    for (let i = 0; i < PASSTHROUGH_TOKEN_LIMIT; i++) {
      expect((await post("unverified_passthrough", "tok-burst")).status).toBe(
        200,
      );
    }

    const res = await post("unverified_passthrough", "tok-burst");

    expect(res.status).toBe(429);
    expect(revokeSessionMock).toHaveBeenCalledTimes(PASSTHROUGH_TOKEN_LIMIT);
  });
});
