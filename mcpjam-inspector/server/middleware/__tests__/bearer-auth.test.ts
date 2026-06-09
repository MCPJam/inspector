/**
 * Bearer Auth Middleware Tests
 *
 * Focus: the `sk_` (WorkOS API key) branch — the security-critical new code.
 * Covers:
 *   - missing / wrong-format bearer → 401
 *   - `sk_` invalid → 401
 *   - `sk_` valid → next() runs with context set
 *   - request-local memoization (validate called once per request)
 *   - per-key rate limit triggers 429 after burst
 *   - cross-key rate limit isolation
 *
 * WorkOS SDK and identity helpers are mocked at module level via `vi.mock`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";

// Mocks must be declared before importing the SUT.
const validateApiKeyMock = vi.fn();
vi.mock("../../services/workos-client.js", () => ({
  getWorkOSClient: () => ({
    apiKeys: { validateApiKey: validateApiKeyMock },
  }),
}));

const resolveUserByExternalIdMock = vi.fn();
vi.mock("../../services/identity.js", () => ({
  resolveUserByExternalId: resolveUserByExternalIdMock,
}));

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
  resetWorkOSRateLimitForTests,
} from "../bearer-auth.js";

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
    }),
  );
  return app;
}

beforeEach(() => {
  validateApiKeyMock.mockReset();
  resolveUserByExternalIdMock.mockReset();
  resetWorkOSRateLimitForTests();
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

describe("bearerAuthMiddleware — sk_ WorkOS API key branch", () => {
  it("returns 401 when WorkOS marks the key as invalid", async () => {
    validateApiKeyMock.mockResolvedValueOnce({ apiKey: null });

    const res = await createApp().request("/test", {
      headers: { authorization: "Bearer sk_invalid_value" },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { code?: string; message?: string };
    expect(body.code).toBe("UNAUTHORIZED");
    expect(body.message).toMatch(/Invalid API key/i);
    expect(validateApiKeyMock).toHaveBeenCalledTimes(1);
    expect(resolveUserByExternalIdMock).not.toHaveBeenCalled();
  });

  it("returns 401 when WorkOS validates but the MCPJam user is unknown", async () => {
    validateApiKeyMock.mockResolvedValueOnce({
      apiKey: { id: "api_key_x", owner: { id: "user_x" } },
    });
    resolveUserByExternalIdMock.mockResolvedValueOnce(null);

    const res = await createApp().request("/test", {
      headers: { authorization: "Bearer sk_valid_but_unknown" },
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/Unknown user/i);
  });

  it("sets identity context and calls next() on valid sk_ key", async () => {
    validateApiKeyMock.mockResolvedValueOnce({
      apiKey: { id: "api_key_42", owner: { id: "user_42" } },
    });
    resolveUserByExternalIdMock.mockResolvedValueOnce({
      _id: "mcpjam_user_42",
    });

    const res = await createApp().request("/test", {
      headers: { authorization: "Bearer sk_live_abc" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.authMethod).toBe("workos_api_key");
    expect(body.workosApiKeyId).toBe("api_key_42");
    expect(body.workosUserId).toBe("user_42");
    expect(body.mcpjamUserId).toBe("mcpjam_user_42");
  });
});

describe("bearerAuthMiddleware — per-key rate limit", () => {
  it("admits at least 10 burst requests for the same key, then rejects with 429", async () => {
    validateApiKeyMock.mockResolvedValue({
      apiKey: { id: "api_key_burst", owner: { id: "user_burst" } },
    });
    resolveUserByExternalIdMock.mockResolvedValue({ _id: "mcpjam_user_burst" });

    const app = createApp();
    const ok: number[] = [];
    let throttled = 0;
    let lastThrottledStatus = 0;
    for (let i = 0; i < 12; i++) {
      const res = await app.request("/test", {
        headers: { authorization: "Bearer sk_burst" },
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

  it("isolates rate-limit buckets per WorkOS key id", async () => {
    // Bucket A — drain it
    validateApiKeyMock.mockImplementation(async ({ value }) => ({
      apiKey: {
        id: value === "sk_a" ? "api_key_a" : "api_key_b",
        owner: { id: value === "sk_a" ? "user_a" : "user_b" },
      },
    }));
    resolveUserByExternalIdMock.mockResolvedValue({ _id: "mcpjam_user" });

    const app = createApp();
    for (let i = 0; i < 11; i++) {
      await app.request("/test", {
        headers: { authorization: "Bearer sk_a" },
      });
    }
    // Now sk_b should still succeed (separate bucket)
    const res = await app.request("/test", {
      headers: { authorization: "Bearer sk_b" },
    });
    expect(res.status).toBe(200);
  });
});

describe("bearerAuthMiddleware — request-local memoization", () => {
  it("only invokes WorkOS validate once per request even when bearer-auth runs multiple times", async () => {
    validateApiKeyMock.mockResolvedValue({
      apiKey: { id: "api_key_memo", owner: { id: "user_memo" } },
    });
    resolveUserByExternalIdMock.mockResolvedValue({ _id: "mcpjam_user_memo" });

    // Simulate the real wiring: bearer-auth on a parent router AND on a
    // sub-router (as `/api/web/api-keys/*` does explicitly).
    const app = new Hono();
    app.use("*", bearerAuthMiddleware);
    app.use("*", bearerAuthMiddleware);
    app.get("/double", (c) => c.json({ ok: true }));

    const res = await app.request("/double", {
      headers: { authorization: "Bearer sk_memo" },
    });

    expect(res.status).toBe(200);
    expect(validateApiKeyMock).toHaveBeenCalledTimes(1);
  });
});
