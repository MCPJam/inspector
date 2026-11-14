/**
 * The auth middleware log the request path on a refusal, and those rows ship
 * to Axiom. A credential route carries its secret in the path
 * (`/api/web/score/runs/<token>`, `/results/<token>`), so each of these lines
 * logs the registry-scrubbed path, never `c.req.path` as it came. (The logger
 * scrubs every string again on the way out — `shared/log-scrubber.ts` — but
 * these assertions are on what the middleware hands it.)
 */
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock, classifyAuthKitBearerMock, resolveSlackActingUser } =
  vi.hoisted(() => ({
    loggerMock: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    classifyAuthKitBearerMock: vi.fn(),
    resolveSlackActingUser: vi.fn(),
  }));

vi.mock("../../utils/logger.js", () => ({ logger: loggerMock }));

vi.mock("../../services/authkit-jwt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/authkit-jwt.js")>()),
  classifyAuthKitBearer: classifyAuthKitBearerMock,
}));

vi.mock("../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: vi.fn(async () => ({
    valid: false,
    reason: "not_guest",
  })),
}));

vi.mock("../../services/slack-backend.js", () => ({
  resolveSlackActingUser,
  SlackBackendUnavailable: class SlackBackendUnavailable extends Error {},
}));

import { AuthKitVerificationError } from "../../services/authkit-jwt.js";
import { bearerAuthMiddleware } from "../bearer-auth.js";
import { resolveOptionalActor } from "../optional-actor.js";
import { requireVerifiedAuth } from "../require-verified-auth.js";
import { resetSlackRateLimitForTests } from "../slack-service-auth.js";

const SCORE_RUN_PATH = "/api/web/score/runs/SENTINEL_tok_123";
const SCRUBBED_SCORE_RUN_PATH = "/api/web/score/runs/[redacted]";

function appWith(...middleware: Parameters<Hono["use"]>[1][]): Hono {
  const app = new Hono();
  for (const handler of middleware) app.use("*", handler);
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

/** Every context object handed to the logger, as one string. */
function everythingLogged(): string {
  return JSON.stringify([
    loggerMock.info.mock.calls,
    loggerMock.warn.mock.calls,
    loggerMock.error.mock.calls,
    loggerMock.debug.mock.calls,
  ]);
}

beforeEach(() => {
  for (const fn of Object.values(loggerMock)) fn.mockReset();
  classifyAuthKitBearerMock.mockReset();
});

describe("auth middleware log a scrubbed path", () => {
  it("bearer auth, rejecting an AuthKit bearer", async () => {
    classifyAuthKitBearerMock.mockResolvedValue({
      kind: "invalid",
      reason: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    });

    const res = await appWith(bearerAuthMiddleware).request(SCORE_RUN_PATH, {
      headers: { Authorization: "Bearer eyJ.forged.token" },
    });

    expect(res.status).toBe(401);
    expect(loggerMock.info).toHaveBeenCalledWith(
      "Rejected an AuthKit bearer that failed verification",
      expect.objectContaining({
        event: "auth.authkit_jwt_rejected",
        path: SCRUBBED_SCORE_RUN_PATH,
      }),
    );
    expect(everythingLogged()).not.toContain("SENTINEL");
  });

  it("requireVerifiedAuth, rejecting an unverified bearer", async () => {
    const verify = vi
      .fn()
      .mockRejectedValue(new AuthKitVerificationError("bad signature"));
    const seed: Parameters<Hono["use"]>[1] = async (c, next) => {
      c.set("authMethod", "unverified_passthrough");
      return next();
    };

    const res = await appWith(
      seed,
      requireVerifiedAuth({ verify: verify as never }),
    ).request("/results/SENTINEL_tok_123", {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });

    expect(res.status).toBe(401);
    expect(loggerMock.info).toHaveBeenCalledWith(
      "Rejected unverified bearer on a non-proxying v1 route",
      expect.objectContaining({
        event: "auth.require_verified_auth_denied",
        path: "/results/[redacted]",
      }),
    );
    expect(everythingLogged()).not.toContain("SENTINEL");
  });

  it("resolveOptionalActor, failing to resolve the bearer", async () => {
    const res = await appWith(
      resolveOptionalActor({
        verify: vi.fn().mockRejectedValue(new Error("boom")) as never,
        resolveUser: vi.fn() as never,
      }),
    ).request(`${SCORE_RUN_PATH}?code=SENTINEL_code`, {
      headers: { Authorization: "Bearer some-token" },
    });

    expect(res.status).toBe(200);
    expect(loggerMock.info).toHaveBeenCalledWith(
      "Could not resolve an optional actor from the bearer",
      expect.objectContaining({
        event: "auth.optional_actor_unresolved",
        path: SCRUBBED_SCORE_RUN_PATH,
      }),
    );
    expect(everythingLogged()).not.toContain("SENTINEL");
  });

  describe("slack service auth", () => {
    const TOKEN = "slk_test_token_value_0123456789abcdef";

    beforeEach(() => {
      resetSlackRateLimitForTests();
      resolveSlackActingUser.mockReset();
      process.env.MCPJAM_SLACK_SERVICE_TOKEN_HASH = createHash("sha256")
        .update(TOKEN)
        .digest("hex");
    });

    afterEach(() => {
      delete process.env.MCPJAM_SLACK_SERVICE_TOKEN_HASH;
    });

    it("refusing a non-allowlisted path", async () => {
      const res = await appWith(bearerAuthMiddleware).request(
        "/bench/results/SENTINEL_hex",
        {
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "x-mcpjam-slack-team-id": "T1",
            "x-mcpjam-slack-user-id": "U1",
          },
        },
      );

      expect(res.status).toBe(401);
      expect(loggerMock.warn).toHaveBeenCalledWith(
        "Slack service token used on a non-allowlisted path",
        { path: "/bench/results/[redacted]" },
      );
      expect(everythingLogged()).not.toContain("SENTINEL");
    });
  });
});
