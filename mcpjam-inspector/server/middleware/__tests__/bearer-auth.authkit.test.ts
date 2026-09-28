/**
 * The JWT branch of `bearerAuthMiddleware`: what the gateway does with each
 * verdict `classifyAuthKitBearer` can return, and that the other credential
 * classes never reach it.
 *
 * The classifier itself is covered in
 * `services/__tests__/authkit-jwt-gateway.test.ts`, and against a real WorkOS
 * JWKS in `bearer-auth.emulator.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  classifyAuthKitBearerMock,
  validateGuestTokenMock,
  validateApiKeyMock,
  loggerMock,
} = vi.hoisted(() => ({
  classifyAuthKitBearerMock: vi.fn(),
  validateGuestTokenMock: vi.fn(),
  validateApiKeyMock: vi.fn(),
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../services/authkit-jwt.js", () => ({
  classifyAuthKitBearer: classifyAuthKitBearerMock,
}));

vi.mock("../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../services/workos-client.js", () => ({
  getWorkOSClient: () => ({
    apiKeys: { createValidation: validateApiKeyMock },
  }),
}));

vi.mock("../../services/identity.js", () => ({
  resolveUserByExternalId: vi.fn(async () => ({ _id: "mcpjam_user_1" })),
}));

vi.mock("../../services/workos-key-bindings.js", () => ({
  lookupWorkosKeyBinding: vi.fn(async () => ({
    mcpjamOrganizationId: "org_convex_1",
  })),
}));

vi.mock("../../utils/logger.js", () => ({ logger: loggerMock }));

import {
  SESSION_REVOKE_PATH,
  bearerAuthMiddleware,
  resetAuthKitKeysWarningForTests,
  resetWorkOSRateLimitForTests,
} from "../bearer-auth.js";
import {
  RevokedSessionCache,
  setRevokedSessionCacheForTests,
} from "../../services/revoked-session-cache.js";

const next = vi.fn();

function createApp(): Hono {
  const app = new Hono();
  app.use("*", bearerAuthMiddleware);
  const echo = (c: any) => {
    next();
    return c.json({
      authMethod: c.get("authMethod") ?? null,
      workosUserId: c.get("workosUserId") ?? null,
      workosSessionId: c.get("workosSessionId") ?? null,
      guestId: c.get("guestId") ?? null,
    });
  };
  app.all("/test", echo);
  app.all("/api/v1/me", echo);
  app.all(SESSION_REVOKE_PATH, echo);
  return app;
}

const request = (token: string, path = "/test") =>
  createApp().request(path, {
    headers: { Authorization: `Bearer ${token}` },
  });

/** A list that never finishes loading, holding only what a test marks. */
function unloadedRevocationList(): RevokedSessionCache {
  return new RevokedSessionCache({
    fetchPage: () => new Promise(() => {}),
  });
}

afterEach(() => {
  setRevokedSessionCacheForTests(undefined);
});

beforeEach(() => {
  next.mockReset();
  classifyAuthKitBearerMock.mockReset();
  validateGuestTokenMock.mockReset();
  validateApiKeyMock.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  validateGuestTokenMock.mockResolvedValue({
    valid: false,
    reason: "not_guest",
  });
  resetWorkOSRateLimitForTests();
  resetAuthKitKeysWarningForTests();
});

describe("bearerAuthMiddleware — AuthKit JWTs", () => {
  it("admits a verified token with its user and session", async () => {
    classifyAuthKitBearerMock.mockResolvedValue({
      kind: "verified",
      sub: "user_1",
      sid: "session_1",
    });

    const res = await request("eyJ.valid.token");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authMethod: "authkit_jwt",
      workosUserId: "user_1",
      workosSessionId: "session_1",
      guestId: null,
    });
    expect(classifyAuthKitBearerMock).toHaveBeenCalledWith("eyJ.valid.token");
  });

  it("refuses a token that fails verification before any handler runs", async () => {
    classifyAuthKitBearerMock.mockResolvedValue({
      kind: "invalid",
      reason: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    });

    const res = await request("eyJ.forged.token");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      code: "UNAUTHORIZED",
      message: "Invalid or expired session token",
    });
    expect(next).not.toHaveBeenCalled();
    expect(loggerMock.info).toHaveBeenCalledWith(
      "Rejected an AuthKit bearer that failed verification",
      expect.objectContaining({
        event: "auth.authkit_jwt_rejected",
        reason: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
      }),
    );
  });

  it("defers to Convex, with one throttled warning, while AuthKit's keys are unreachable", async () => {
    classifyAuthKitBearerMock.mockResolvedValue({
      kind: "keys_unavailable",
      issuer: "https://api.workos.com/",
      reason: "JWKS timeout",
    });

    const first = await request("eyJ.any.token");
    const second = await request("eyJ.any.token");

    for (const res of [first, second]) {
      expect(res.status).toBe(200);
      expect((await res.json()).authMethod).toBe("unverified_passthrough");
    }
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("AuthKit signing keys unavailable"),
      expect.objectContaining({ event: "auth.authkit_jwks_unavailable" }),
    );
  });

  it.each([[{ kind: "foreign_audience" }], [{ kind: "not_authkit" }]])(
    "lets %o through unverified for downstream to judge",
    async (verdict) => {
      classifyAuthKitBearerMock.mockResolvedValue(verdict);

      const res = await request("eyJ.other.token");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        authMethod: "unverified_passthrough",
        workosUserId: null,
        workosSessionId: null,
        guestId: null,
      });
    },
  );
});

describe("bearerAuthMiddleware — revoked sessions (MJ-011)", () => {
  beforeEach(() => {
    classifyAuthKitBearerMock.mockResolvedValue({
      kind: "verified",
      sub: "user_1",
      sid: "session_revoked",
    });
  });

  it("refuses a session known to be revoked with SESSION_REVOKED", async () => {
    const list = unloadedRevocationList();
    list.markRevokedLocally("session_revoked");
    setRevokedSessionCacheForTests(list);

    const res = await request("eyJ.valid.token");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      code: "SESSION_REVOKED",
      message: expect.any(String),
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("answers in the v1 envelope on /api/v1", async () => {
    const list = unloadedRevocationList();
    list.markRevokedLocally("session_revoked");
    setRevokedSessionCacheForTests(list);

    const res = await request("eyJ.valid.token", "/api/v1/me");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      code: "UNAUTHORIZED",
      message: expect.any(String),
      details: { reason: "SESSION_REVOKED" },
    });
  });

  it("admits a session it has not seen revoked, even before the list has loaded", async () => {
    // Routes behind this middleware forward the bearer to Convex, which checks
    // the durable record itself; requiring a current list is the job of the
    // routes that decide on their own.
    setRevokedSessionCacheForTests(unloadedRevocationList());

    const res = await request("eyJ.valid.token");

    expect(res.status).toBe(200);
    expect((await res.json()).workosSessionId).toBe("session_revoked");
  });

  it("still lets the sign-out route see the session", async () => {
    const list = unloadedRevocationList();
    list.markRevokedLocally("session_revoked");
    setRevokedSessionCacheForTests(list);

    const res = await request("eyJ.valid.token", SESSION_REVOKE_PATH);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      authMethod: "authkit_jwt",
      workosSessionId: "session_revoked",
    });
  });

  it("changes nothing where no revoked-session list runs", async () => {
    setRevokedSessionCacheForTests(null);

    const res = await request("eyJ.valid.token");

    expect(res.status).toBe(200);
  });
});

describe("bearerAuthMiddleware — other credentials never reach the AuthKit verifier", () => {
  it("a valid guest token", async () => {
    validateGuestTokenMock.mockResolvedValue({
      valid: true,
      guestId: "guest_1",
    });

    const res = await request("eyJ.guest.token");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      authMethod: "guest",
      guestId: "guest_1",
    });
    expect(classifyAuthKitBearerMock).not.toHaveBeenCalled();
  });

  it("a WorkOS API key", async () => {
    validateApiKeyMock.mockResolvedValue({
      apiKey: { id: "api_key_1", owner: { id: "user_1" } },
    });

    const res = await request("sk_test_key");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ authMethod: "workos_api_key" });
    expect(classifyAuthKitBearerMock).not.toHaveBeenCalled();
    expect(validateGuestTokenMock).not.toHaveBeenCalled();
  });
});
