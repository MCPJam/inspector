/**
 * Tests for the externalId → MCPJam user resolver, focused on 404
 * disambiguation: the backend route's own "User not found" 404 must map to
 * `null` (caller 401s), while a routing-level 404 — the route not deployed
 * or CONVEX_HTTP_URL pointing at the wrong deployment — must throw so the
 * misconfiguration surfaces as a 500 instead of silent "Unknown user" 401s.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveUserByExternalId } from "../identity.js";

const CONVEX_HTTP_URL = "https://example.convex.site";
const SERVICE_TOKEN = "test-service-token";

function mockFetchResponse(status: number, body: string | null) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("resolveUserByExternalId", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", CONVEX_HTTP_URL);
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", SERVICE_TOKEN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("resolves { _id } from a 200 and sends the service token", async () => {
    const fetchMock = mockFetchResponse(
      200,
      JSON.stringify({ ok: true, userId: "users_abc123" })
    );

    const result = await resolveUserByExternalId("workos|user_1");

    expect(result).toEqual({ _id: "users_abc123" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${CONVEX_HTTP_URL}/internal/v1/users/lookup-by-external-id?externalId=workos%7Cuser_1`
    );
    expect(init.headers["x-inspector-service-token"]).toBe(SERVICE_TOKEN);
  });

  it("returns null on the route's own 'User not found' 404", async () => {
    mockFetchResponse(
      404,
      JSON.stringify({ ok: false, error: "User not found" })
    );

    await expect(resolveUserByExternalId("workos|missing")).resolves.toBeNull();
  });

  it("throws on a routing-level 404 (route not deployed)", async () => {
    // Convex's own 404 for an unknown path is not the route's JSON shape.
    mockFetchResponse(404, "No matching routes found");

    await expect(resolveUserByExternalId("workos|user_1")).rejects.toThrow(
      /route not found/
    );
  });

  it("throws on other non-OK statuses", async () => {
    mockFetchResponse(
      401,
      JSON.stringify({ ok: false, error: "Unauthorized" })
    );

    await expect(resolveUserByExternalId("workos|user_1")).rejects.toThrow(
      /User lookup failed \(401\)/
    );
  });

  it("throws when the 200 body is missing a string userId", async () => {
    mockFetchResponse(200, JSON.stringify({ ok: true }));

    await expect(resolveUserByExternalId("workos|user_1")).rejects.toThrow(
      /invalid body/
    );
  });

  it("throws when config is missing", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "");

    await expect(resolveUserByExternalId("workos|user_1")).rejects.toThrow(
      /CONVEX_HTTP_URL/
    );
  });
});
