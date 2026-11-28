/**
 * The `sk_` branch with `MCPJAM_TOKEN_EXCHANGE`: the backend validates the
 * key and issues its token; this server sets the same identity as local
 * validation and sends that token instead of acting-as. Off, local validation
 * runs exactly as before (`bearer-auth.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  exchangeApiKeyMock,
  validateApiKeyMock,
  resolveUserByExternalIdMock,
  lookupWorkosKeyBindingMock,
} = vi.hoisted(() => ({
  exchangeApiKeyMock: vi.fn(),
  validateApiKeyMock: vi.fn(),
  resolveUserByExternalIdMock: vi.fn(),
  lookupWorkosKeyBindingMock: vi.fn(),
}));

vi.mock("../../services/token-exchange.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../services/token-exchange.js")
  >()),
  exchangeApiKey: exchangeApiKeyMock,
}));
vi.mock("../../services/workos-client.js", () => ({
  getWorkOSClient: () => ({
    apiKeys: { createValidation: validateApiKeyMock },
  }),
}));
vi.mock("../../services/identity.js", () => ({
  resolveUserByExternalId: resolveUserByExternalIdMock,
}));
vi.mock("../../services/workos-key-bindings.js", () => ({
  lookupWorkosKeyBinding: lookupWorkosKeyBindingMock,
}));
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
import { getRequestLocal } from "../request-local.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { ServiceCredentialUnavailableError } from "../../services/service-credential.js";

const KEY = "sk_test_exchange_key";

function exchangedResult(apiKeyId = "api_key_1") {
  return {
    kind: "exchanged" as const,
    value: {
      token: "exchanged-jwt",
      expiresAt: Date.now() + 600_000,
      apiKeyId,
      userId: "user_doc_1",
      externalId: "user_workos_1",
      organizationId: "org_1",
    },
  };
}

function createApp(): Hono {
  const app = new Hono();
  app.use("*", bearerAuthMiddleware);
  app.get("/test", async (c) =>
    c.json({
      authMethod: c.get("authMethod") ?? null,
      workosApiKeyId: c.get("workosApiKeyId") ?? null,
      workosUserId: c.get("workosUserId") ?? null,
      mcpjamUserId: c.get("mcpjamUserId") ?? null,
      mcpjamOrganizationId: c.get("mcpjamOrganizationId") ?? null,
      exchanged: getRequestLocal(c, "exchangedConvexBearer")?.token ?? null,
      convexBearer: await getConvexBearerForRequest(c),
    }),
  );
  return app;
}

function request(app = createApp()) {
  return app.request("/test", { headers: { authorization: `Bearer ${KEY}` } });
}

beforeEach(() => {
  exchangeApiKeyMock.mockReset();
  validateApiKeyMock.mockReset();
  resolveUserByExternalIdMock.mockReset();
  lookupWorkosKeyBindingMock.mockReset();
  resetWorkOSRateLimitForTests();
  vi.stubEnv("MCPJAM_TOKEN_EXCHANGE", "on");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("bearerAuthMiddleware: sk_ keys through the token exchange", () => {
  it("sets the key's identity and makes the backend's token the request's Convex bearer", async () => {
    exchangeApiKeyMock.mockResolvedValue(exchangedResult());
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authMethod: "workos_api_key",
      workosApiKeyId: "api_key_1",
      workosUserId: "user_workos_1",
      mcpjamUserId: "user_doc_1",
      mcpjamOrganizationId: "org_1",
      exchanged: "exchanged-jwt",
      convexBearer: "exchanged-jwt",
    });
    expect(exchangeApiKeyMock).toHaveBeenCalledWith(KEY, "rest");
    // WorkOS and the old lookups are the backend's job now.
    expect(validateApiKeyMock).not.toHaveBeenCalled();
    expect(resolveUserByExternalIdMock).not.toHaveBeenCalled();
    expect(lookupWorkosKeyBindingMock).not.toHaveBeenCalled();
  });

  it("validates locally, as before, when the switch is off", async () => {
    vi.stubEnv("MCPJAM_TOKEN_EXCHANGE", "");
    validateApiKeyMock.mockResolvedValue({
      apiKey: { id: "api_key_1", owner: { id: "user_workos_1" } },
    });
    resolveUserByExternalIdMock.mockResolvedValue({ _id: "user_doc_1" });
    lookupWorkosKeyBindingMock.mockResolvedValue({
      mcpjamOrganizationId: "org_1",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          ok: true,
          token: "acting-as-jwt",
          expiresAt: Date.now() + 7_200_000,
        }),
      ),
    );
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example.convex.site");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-for-tests");
    try {
      const res = await request();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        authMethod: "workos_api_key",
        exchanged: null,
        convexBearer: "acting-as-jwt",
      });
      expect(exchangeApiKeyMock).not.toHaveBeenCalled();
      expect(validateApiKeyMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to local validation against a backend without the exchange", async () => {
    exchangeApiKeyMock.mockResolvedValue({ kind: "unsupported" });
    validateApiKeyMock.mockResolvedValue({ apiKey: null });
    const res = await request();
    expect(res.status).toBe(401);
    expect(validateApiKeyMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "key_orphaned",
      { details: { reason: "ORPHANED_KEY" }, code: "UNAUTHORIZED" },
    ],
    [
      "key_expired",
      { details: { reason: "EXPIRED_KEY" }, code: "UNAUTHORIZED" },
    ],
    ["user_unknown", { message: "Unknown user", code: "UNAUTHORIZED" }],
    ["key_invalid", { message: "Invalid API key", code: "UNAUTHORIZED" }],
    [
      "workos_unavailable",
      { message: "Invalid API key", code: "UNAUTHORIZED" },
    ],
  ])(
    "answers the backend's %s refusal with today's 401",
    async (reason, body) => {
      exchangeApiKeyMock.mockResolvedValue({
        kind: "refused",
        status: 401,
        reason,
      });
      const res = await request();
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject(body);
    },
  );

  it("passes on a 403 for a user who may not act", async () => {
    exchangeApiKeyMock.mockResolvedValue({
      kind: "refused",
      status: 403,
      reason: "not_member",
      message: "This API key's user is not a member of its organization.",
    });
    const res = await request();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      code: "FORBIDDEN",
      message: "This API key's user is not a member of its organization.",
    });
  });

  it("rate-limits on the key id the backend named", async () => {
    exchangeApiKeyMock.mockResolvedValue(exchangedResult("api_key_busy"));
    const app = createApp();
    for (let i = 0; i < 10; i += 1) {
      expect((await request(app)).status).toBe(200);
    }
    const limited = await request(app);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();

    exchangeApiKeyMock.mockResolvedValue(exchangedResult("api_key_other"));
    expect((await request(app)).status).toBe(200);
  });

  it("answers hosted-only on a server without the service credential", async () => {
    exchangeApiKeyMock.mockRejectedValue(
      new ServiceCredentialUnavailableError("Using an MCPJam API key (sk_…)"),
    );
    const res = await request();
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      details: { reason: "FEATURE_REQUIRES_HOSTED" },
    });
  });

  it("answers 500 when the exchange itself fails", async () => {
    exchangeApiKeyMock.mockRejectedValue(
      new Error("Token exchange failed (502)"),
    );
    const res = await request();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  });
});
