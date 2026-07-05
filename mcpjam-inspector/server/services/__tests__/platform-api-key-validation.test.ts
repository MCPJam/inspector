/**
 * Tests for the platform API key validation client, focused on 404
 * disambiguation (ported from the deleted identity.test.ts, which covered the
 * same contract for the predecessor service): the backend route's own
 * "Key not found" 404 must map to `null` (caller 401s), while a routing-level
 * 404 — the route not deployed or CONVEX_HTTP_URL pointing at the wrong
 * deployment — must throw so the misconfiguration surfaces as a 500 instead
 * of silent "Invalid API key" 401s for every caller.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  hashApiKey,
  validatePlatformApiKey,
} from "../platform-api-key-validation.js";

const CONVEX_HTTP_URL = "https://example.convex.site";
const SERVICE_TOKEN = "test-service-token";
const TOKEN_HASH = "a".repeat(64);

const VALID_BODY = {
  ok: true,
  keyId: "platform_key_1",
  userId: "users_abc123",
  externalId: "workos|user_1",
  organizationId: "orgs_xyz789",
};

function mockFetchResponse(status: number, body: string | null) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("validatePlatformApiKey", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", CONVEX_HTTP_URL);
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", SERVICE_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("resolves the identity from a 200 and POSTs the hash with the service token", async () => {
    const fetchMock = mockFetchResponse(200, JSON.stringify(VALID_BODY));

    const result = await validatePlatformApiKey(TOKEN_HASH);

    expect(result).toEqual({
      keyId: "platform_key_1",
      userId: "users_abc123",
      externalId: "workos|user_1",
      organizationId: "orgs_xyz789",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${CONVEX_HTTP_URL}/internal/v1/api-keys/validate`);
    expect(init.method).toBe("POST");
    expect(init.headers["x-inspector-service-token"]).toBe(SERVICE_TOKEN);
    expect(JSON.parse(init.body)).toEqual({ tokenHash: TOKEN_HASH });
  });

  it("returns null on the route's own 'Key not found' 404", async () => {
    mockFetchResponse(
      404,
      JSON.stringify({ ok: false, error: "Key not found" }),
    );

    await expect(validatePlatformApiKey(TOKEN_HASH)).resolves.toBeNull();
  });

  it("throws on a routing-level 404 (route not deployed)", async () => {
    // Convex's own 404 for an unknown path is not the route's JSON shape.
    mockFetchResponse(404, "No matching routes found");

    await expect(validatePlatformApiKey(TOKEN_HASH)).rejects.toThrow(
      /routing 404/,
    );
  });

  it("throws on an unexpected non-2xx status", async () => {
    mockFetchResponse(500, JSON.stringify({ ok: false, error: "boom" }));

    await expect(validatePlatformApiKey(TOKEN_HASH)).rejects.toThrow(
      /status 500/,
    );
  });

  it("throws on a malformed 200 body", async () => {
    mockFetchResponse(200, JSON.stringify({ ok: true, keyId: 42 }));

    await expect(validatePlatformApiKey(TOKEN_HASH)).rejects.toThrow(
      /malformed body/,
    );
  });

  it("throws when CONVEX_HTTP_URL / INSPECTOR_SERVICE_TOKEN are missing", async () => {
    vi.unstubAllEnvs();
    await expect(validatePlatformApiKey(TOKEN_HASH)).rejects.toThrow();
  });
});

describe("hashApiKey", () => {
  it("produces the sha256 hex the backend stores (sha256Hex parity)", () => {
    // Known vector: sha256("abc") — proves algorithm + hex casing match the
    // backend's Web Crypto sha256Hex implementation.
    expect(hashApiKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hashApiKey("sk_mcpjam_" + "0".repeat(48))).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});
