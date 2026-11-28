import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchangeApiKey,
  isTokenExchangeEnabled,
  resetTokenExchangeCacheForTests,
  tokenExchangeCacheForTests,
} from "../token-exchange.js";

const KEY = "sk_test_raw_key_value_0123456789";
const NOW = 1_800_000_000_000;

function exchanged(expiresAt = NOW + 600_000) {
  return Response.json({
    ok: true,
    token: "exchanged-jwt",
    expiresAt,
    apiKeyId: "api_key_1",
    userId: "user_doc_1",
    externalId: "user_workos_1",
    organizationId: "org_1",
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example.convex.site");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-for-tests");
  resetTokenExchangeCacheForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("MCPJAM_TOKEN_EXCHANGE", () => {
  it("is off unless set to an on value", () => {
    expect(isTokenExchangeEnabled({})).toBe(false);
    expect(isTokenExchangeEnabled({ MCPJAM_TOKEN_EXCHANGE: "off" })).toBe(
      false,
    );
    expect(isTokenExchangeEnabled({ MCPJAM_TOKEN_EXCHANGE: "false" })).toBe(
      false,
    );
    for (const on of ["on", "1", "true", " ON "]) {
      expect(isTokenExchangeEnabled({ MCPJAM_TOKEN_EXCHANGE: on })).toBe(true);
    }
  });
});

describe("exchangeApiKey", () => {
  it("presents the key with the service credential and returns the backend's token", async () => {
    const fetchMock = vi.fn(async () => exchanged());
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeApiKey(KEY, "rest")).resolves.toEqual({
      kind: "exchanged",
      value: {
        token: "exchanged-jwt",
        expiresAt: NOW + 600_000,
        apiKeyId: "api_key_1",
        userId: "user_doc_1",
        externalId: "user_workos_1",
        organizationId: "org_1",
      },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("https://backend.example.convex.site/web/token-exchange");
    expect(init.headers["x-inspector-service-token"]).toBe(
      "service-token-for-tests",
    );
    expect(init.headers).not.toHaveProperty("Authorization");
    expect(JSON.parse(String(init.body))).toEqual({
      subject_token_type: "api_key",
      subject_token: KEY,
      surface: "rest",
    });
  });

  it("reuses the token until a minute before it expires, then exchanges again", async () => {
    const fetchMock = vi.fn(async () => exchanged());
    vi.stubGlobal("fetch", fetchMock);

    await exchangeApiKey(KEY, "rest");
    vi.setSystemTime(NOW + 539_000);
    await exchangeApiKey(KEY, "rest");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 540_000);
    fetchMock.mockImplementationOnce(async () => exchanged(NOW + 1_140_000));
    await exchangeApiKey(KEY, "rest");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keys the cache by a keyed digest and never stores the key itself", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => exchanged()),
    );
    await exchangeApiKey(KEY, "rest");

    const { keys, values } = tokenExchangeCacheForTests();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^rest:[0-9a-f]{64}$/);
    expect(JSON.stringify({ keys, values })).not.toContain(KEY);
  });

  it("asks once for concurrent requests with the same key", async () => {
    const fetchMock = vi.fn(async () => exchanged());
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([
      exchangeApiKey(KEY, "rest"),
      exchangeApiKey(KEY, "rest"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes on a refusal with its reason, and caches nothing", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          ok: false,
          code: "UNAUTHORIZED",
          reason: "key_orphaned",
          error: "This API key is not bound to an organization.",
        },
        { status: 401 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeApiKey(KEY, "rest")).resolves.toEqual({
      kind: "refused",
      status: 401,
      reason: "key_orphaned",
      message: "This API key is not bound to an organization.",
    });
    expect(tokenExchangeCacheForTests().keys).toEqual([]);

    fetchMock.mockImplementationOnce(async () =>
      Response.json({ ok: false, reason: "not_member" }, { status: 403 }),
    );
    await expect(exchangeApiKey(KEY, "rest")).resolves.toMatchObject({
      kind: "refused",
      status: 403,
      reason: "not_member",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops a cached token once a refresh is refused", async () => {
    const fetchMock = vi.fn(async () => exchanged());
    vi.stubGlobal("fetch", fetchMock);
    await exchangeApiKey(KEY, "rest");
    vi.setSystemTime(NOW + 550_000);
    fetchMock.mockImplementationOnce(async () =>
      Response.json({ ok: false, reason: "key_invalid" }, { status: 401 }),
    );
    await expect(exchangeApiKey(KEY, "rest")).resolves.toMatchObject({
      kind: "refused",
    });
    expect(tokenExchangeCacheForTests().keys).toEqual([]);
  });

  it("reports a backend without the exchange route as unsupported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("No matching routes found", { status: 404 }),
      ),
    );
    await expect(exchangeApiKey(KEY, "rest")).resolves.toEqual({
      kind: "unsupported",
    });
  });

  it("throws on a backend failure or a malformed answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: false }, { status: 500 })),
    );
    await expect(exchangeApiKey(KEY, "rest")).rejects.toThrow(
      "Token exchange failed (500)",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true, token: "x" })),
    );
    await expect(exchangeApiKey(KEY, "rest")).rejects.toThrow(
      "Token exchange failed (200)",
    );
  });

  it("needs the service credential", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    await expect(exchangeApiKey(KEY, "rest")).rejects.toMatchObject({
      name: "ServiceCredentialUnavailableError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
