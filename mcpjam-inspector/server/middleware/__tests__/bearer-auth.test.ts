/**
 * Bearer Auth Middleware Tests
 *
 * Focus: the `sk_` (platform API key) branch — the security-critical code.
 * Covers:
 *   - missing / wrong-format bearer → 401
 *   - malformed `sk_` (fails the format gate) → 401 without a backend call
 *   - `sk_` that validates → next() runs with identity AND org context set
 *   - `sk_` that the backend rejects (unknown/revoked/left-org) → 401
 *   - validation throws → 500
 *   - request-local memoization (validate called once per request)
 *   - per-key rate limit triggers 429 after burst
 *   - cross-key rate limit isolation
 *
 * Only the backend validation call is mocked; `hashApiKey` stays real so the
 * rate-limit buckets key off real hashes (distinct keys → distinct buckets).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

const { validatePlatformApiKeyMock } = vi.hoisted(() => ({
  validatePlatformApiKeyMock: vi.fn(),
}));

vi.mock(
  "../../services/platform-api-key-validation.js",
  async (importOriginal) => {
    const actual = await importOriginal<object>();
    return {
      ...actual, // keep the real hashApiKey
      validatePlatformApiKey: validatePlatformApiKeyMock,
    };
  },
);

// Guest validation must always reject for these tests — only the sk_ branch is
// exercised. The real guest validator does network calls we don't want here.
vi.mock("../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: vi.fn(async () => ({
    valid: false,
    reason: "not_guest",
  })),
}));

import {
  bearerAuthMiddleware,
  resetApiKeyRateLimitForTests,
} from "../bearer-auth.js";

// A well-formed platform key: `sk_mcpjam_` + 48 hex chars.
function key(hexChar: string): string {
  return "sk_mcpjam_" + hexChar.repeat(48);
}

const VALID = {
  keyId: "key_42",
  userId: "mcpjam_user_42",
  externalId: "user_42",
  organizationId: "org_42",
};

function createApp(): Hono {
  const app = new Hono();
  app.use("*", bearerAuthMiddleware);
  app.get("/test", (c) =>
    c.json({
      ok: true,
      authMethod: c.get("authMethod") ?? null,
      workosApiKeyId: c.get("workosApiKeyId") ?? null,
      workosUserId: c.get("workosUserId") ?? null,
      mcpjamUserId: c.get("mcpjamUserId") ?? null,
      mcpjamOrganizationId: c.get("mcpjamOrganizationId") ?? null,
    }),
  );
  return app;
}

beforeEach(() => {
  validatePlatformApiKeyMock.mockReset();
  resetApiKeyRateLimitForTests();
});

describe("bearerAuthMiddleware — header gate", () => {
  it("rejects requests without an Authorization header", async () => {
    const res = await createApp().request("/test");
    expect(res.status).toBe(401);
  });

  it("rejects requests where the header isn't Bearer-prefixed", async () => {
    const res = await createApp().request("/test", {
      headers: { authorization: "Basic abc" },
    });
    expect(res.status).toBe(401);
  });
});

describe("bearerAuthMiddleware — sk_ platform API key branch", () => {
  it("rejects a malformed sk_ key with 401 and never calls the backend", async () => {
    const res = await createApp().request("/test", {
      headers: { authorization: "Bearer sk_not_a_valid_key" },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("UNAUTHORIZED");
    expect(body.message).toMatch(/Invalid API key/i);
    expect(validatePlatformApiKeyMock).not.toHaveBeenCalled();
  });

  it("returns 401 when the backend rejects the key (unknown/revoked/left-org)", async () => {
    validatePlatformApiKeyMock.mockResolvedValueOnce(null);

    const res = await createApp().request("/test", {
      headers: { authorization: `Bearer ${key("a")}` },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("UNAUTHORIZED");
    expect(body.message).toMatch(/Invalid API key/i);
    expect(validatePlatformApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it("sets identity + org context and calls next() on a valid key", async () => {
    validatePlatformApiKeyMock.mockResolvedValueOnce(VALID);

    const res = await createApp().request("/test", {
      headers: { authorization: `Bearer ${key("a")}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // Context field names are unchanged from the WorkOS era so downstream
    // consumers keep working; `workosUserId` carries the externalId.
    expect(body.authMethod).toBe("workos_api_key");
    expect(body.workosApiKeyId).toBe("key_42");
    expect(body.workosUserId).toBe("user_42");
    expect(body.mcpjamUserId).toBe("mcpjam_user_42");
    expect(body.mcpjamOrganizationId).toBe("org_42");
  });

  it("returns 500 when validation throws", async () => {
    validatePlatformApiKeyMock.mockRejectedValueOnce(new Error("backend down"));

    const res = await createApp().request("/test", {
      headers: { authorization: `Bearer ${key("a")}` },
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("INTERNAL_ERROR");
  });
});

describe("bearerAuthMiddleware — per-key rate limit", () => {
  it("admits at least 10 burst requests for the same key, then rejects with 429", async () => {
    validatePlatformApiKeyMock.mockResolvedValue(VALID);

    const app = createApp();
    const ok: number[] = [];
    let throttled = 0;
    let lastThrottledStatus = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app.request("/test", {
        headers: { authorization: `Bearer ${key("a")}` },
      });
      if (res.status === 200) {
        ok.push(i);
      } else {
        throttled++;
        lastThrottledStatus = res.status;
      }
    }
    expect(ok.length).toBeGreaterThanOrEqual(10);
    expect(throttled).toBeGreaterThanOrEqual(1);
    expect(lastThrottledStatus).toBe(429);
  });

  it("isolates rate-limit buckets per key (distinct hashes)", async () => {
    validatePlatformApiKeyMock.mockResolvedValue(VALID);

    const app = createApp();
    // Drain bucket for key A.
    for (let i = 0; i < 11; i++) {
      await app.request("/test", {
        headers: { authorization: `Bearer ${key("a")}` },
      });
    }
    // Key B hashes differently → separate bucket → still admitted.
    const res = await app.request("/test", {
      headers: { authorization: `Bearer ${key("b")}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("bearerAuthMiddleware — request-local memoization", () => {
  it("validates once per request even when bearer-auth runs multiple times", async () => {
    validatePlatformApiKeyMock.mockResolvedValue(VALID);

    // Simulate the real wiring: bearer-auth on a parent router AND on a
    // sub-router (as `/api/web/api-keys/*` does explicitly).
    const app = new Hono();
    app.use("*", bearerAuthMiddleware);
    app.use("*", bearerAuthMiddleware);
    app.get("/double", (c) => c.json({ ok: true }));

    const res = await app.request("/double", {
      headers: { authorization: `Bearer ${key("a")}` },
    });

    expect(res.status).toBe(200);
    expect(validatePlatformApiKeyMock).toHaveBeenCalledTimes(1);
  });
});
