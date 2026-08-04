import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Covers the /api/v1/oauth-profiles proxy seam. Two properties matter more
// here than for the host-catalog proxy this mirrors: the route is
// AUTHENTICATED (a per-client OAuth evidence catalog is not public metadata),
// and it has NO fallback — an upstream failure is reported, never papered over
// with some other client's profile. The Convex side is covered separately.

import v1Routes from "../index.js";
import { logger } from "../../../utils/logger.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const AUTH = { authorization: "Bearer test-token" };

const profileEnvelope = {
  schemaVersion: 1,
  catalogRevision: "2026-08-04T00:00:00Z",
  clientId: "example-desktop",
  profileDigest: "abc123",
  profile: { profileVersion: 2 },
};

describe("/api/v1/oauth-profiles", () => {
  const originalEnv = process.env.CONVEX_HTTP_URL;
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env.CONVEX_HTTP_URL = originalEnv;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("rejects an unauthenticated caller — the catalog is not public", async () => {
    const response = await makeApp().request("/api/v1/oauth-profiles");
    expect(response.status).toBe(401);
    // No upstream call is attempted for an anonymous caller.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proxies a profile without exposing the convex host", async () => {
    fetchMock.mockResolvedValue(jsonResponse(profileEnvelope));

    const response = await makeApp().request(
      "/api/v1/oauth-profiles/example-desktop",
      { headers: AUTH },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(profileEnvelope);
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).toBe(
      "https://convex-http.example.com/public/oauth-profiles/example-desktop",
    );
    // Per-account authorized: never cacheable by a shared cache.
    expect(response.headers.get("Cache-Control")).toContain("private");
  });

  it("path-encodes the client id it forwards", async () => {
    fetchMock.mockResolvedValue(jsonResponse(profileEnvelope));

    await makeApp().request("/api/v1/oauth-profiles/a%2Fb", { headers: AUTH });

    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://convex-http.example.com/public/oauth-profiles/a%2Fb",
    );
  });

  it("maps an unknown client to NOT_FOUND", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 404));

    const response = await makeApp().request("/api/v1/oauth-profiles/nope", {
      headers: AUTH,
    });

    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("NOT_FOUND");
  });

  it("reports an unreachable catalog instead of falling back", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const response = await makeApp().request("/api/v1/oauth-profiles", {
      headers: AUTH,
    });

    // There is no bundled copy to serve: emulating a different client than
    // the caller asked for would invalidate every claim the run then makes.
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.code).toBe("SERVER_UNREACHABLE");
    expect(body).not.toHaveProperty("profile");
  });

  it("reports an upstream 5xx as unreachable", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503));

    const response = await makeApp().request("/api/v1/oauth-profiles", {
      headers: AUTH,
    });

    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe("SERVER_UNREACHABLE");
  });

  it("reports a misconfigured deployment rather than silently serving nothing", async () => {
    delete process.env.CONVEX_HTTP_URL;

    const response = await makeApp().request("/api/v1/oauth-profiles", {
      headers: AUTH,
    });

    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe("INTERNAL_ERROR");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lists the catalog for an authenticated caller", async () => {
    const listing = {
      schemaVersion: 1,
      catalogRevision: "rev-1",
      entries: [{ clientId: "example-desktop", profileDigest: "abc" }],
    };
    fetchMock.mockResolvedValue(jsonResponse(listing));

    const response = await makeApp().request("/api/v1/oauth-profiles", {
      headers: AUTH,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(listing);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://convex-http.example.com/public/oauth-profiles",
    );
  });
});
