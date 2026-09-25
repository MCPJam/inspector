/**
 * The JWT branch of `bearerAuthMiddleware`: what the gateway does with each
 * verdict `classifyAuthKitBearer` can return, and that the other credential
 * classes never reach it.
 *
 * The classifier itself is covered in
 * `services/__tests__/authkit-jwt-gateway.test.ts`, and against a real WorkOS
 * JWKS in `bearer-auth.emulator.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  bearerAuthMiddleware,
  resetAuthKitKeysWarningForTests,
  resetWorkOSRateLimitForTests,
} from "../bearer-auth.js";

const next = vi.fn();

function createApp(): Hono {
  const app = new Hono();
  app.use("*", bearerAuthMiddleware);
  app.get("/test", (c) => {
    next();
    return c.json({
      authMethod: c.get("authMethod") ?? null,
      workosUserId: c.get("workosUserId") ?? null,
      workosSessionId: c.get("workosSessionId") ?? null,
      guestId: c.get("guestId") ?? null,
    });
  });
  return app;
}

const request = (token: string) =>
  createApp().request("/test", {
    headers: { Authorization: `Bearer ${token}` },
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
