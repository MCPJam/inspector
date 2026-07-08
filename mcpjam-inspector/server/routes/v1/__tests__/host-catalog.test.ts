import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { bundledHostCompatCatalog } from "@mcpjam/sdk/host-compat";

// Covers the /api/v1/host-catalog proxy seam: unauthenticated access, live
// upstream passthrough (source: live + cacheable), upstream validation, and
// the always-returns-a-catalog guarantees (serve-stale-on-error; bundled
// fallback when Convex is unreachable/unconfigured). The Convex side is
// covered by the backend's marketHostCatalog tests.

import v1Routes from "../index.js";
import { resetHostCatalogCacheForTests } from "../host-catalog.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

const liveEnvelope = () => ({
  schemaVersion: 1,
  version: 3,
  contentHash: "deadbeef",
  publishedAt: 1750000000000,
  catalog: JSON.parse(JSON.stringify(bundledHostCompatCatalog())),
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GET /api/v1/host-catalog", () => {
  const originalEnv = process.env.CONVEX_HTTP_URL;
  const originalFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetHostCatalogCacheForTests();
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    // Assigning `undefined` would coerce to the string "undefined" and leak a
    // truthy env into later tests — delete the key when it started unset.
    if (originalEnv === undefined) delete process.env.CONVEX_HTTP_URL;
    else process.env.CONVEX_HTTP_URL = originalEnv;
    global.fetch = originalFetch;
  });

  it("serves the live catalog unauthenticated (no bearer at all)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(liveEnvelope()));
    const res = await makeApp().request("/api/v1/host-catalog");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const body = await res.json();
    expect(body.source).toBe("live");
    expect(body.version).toBe(3);
    expect(body.catalog.marketHosts).toHaveLength(
      bundledHostCompatCatalog().marketHosts.length
    );
    expect(body.catalog.templatesById.mcpjam.hostStyle).toBe("mcpjam");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://convex-http.example.com/public/host-catalog"
    );
  });

  it("caches the live envelope (second request hits no upstream)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(liveEnvelope()));
    const app = makeApp();
    await app.request("/api/v1/host-catalog");
    const res = await app.request("/api/v1/host-catalog");
    expect((await res.json()).source).toBe("live");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the bundled catalog when CONVEX_HTTP_URL is unset", async () => {
    delete process.env.CONVEX_HTTP_URL;
    const res = await makeApp().request("/api/v1/host-catalog");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.source).toBe("bundled");
    expect(body.version).toBe(0);
    expect(body.catalog.marketHosts).toHaveLength(
      bundledHostCompatCatalog().marketHosts.length
    );
    expect(body.catalog.templatesById["claude-code"].hostStyle).toBe(
      "claude-code"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to bundled on upstream failure with an empty cache", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const res = await makeApp().request("/api/v1/host-catalog");
    expect(res.status).toBe(200);
    expect((await res.json()).source).toBe("bundled");
  });

  it("falls back to bundled when the upstream body fails validation", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ not: "a catalog" }));
    const res = await makeApp().request("/api/v1/host-catalog");
    expect((await res.json()).source).toBe("bundled");
  });

  it("treats upstream 503 (unseeded) as bundled fallback", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "not seeded" }, 503));
    const res = await makeApp().request("/api/v1/host-catalog");
    expect((await res.json()).source).toBe("bundled");
  });

  it("serves the stale cached envelope with revalidation headers when a later refresh fails", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse(liveEnvelope()));
      const app = makeApp();
      await app.request("/api/v1/host-catalog");

      // Past the 300s TTL the refresh fires and fails; last good wins, but
      // must NOT be cacheable for another window (would mask recovery).
      vi.setSystemTime(Date.now() + 301_000);
      fetchMock.mockRejectedValueOnce(new Error("upstream down"));
      const res = await app.request("/api/v1/host-catalog");
      const body = await res.json();
      expect(body.source).toBe("live");
      expect(body.version).toBe(3);
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dedupes concurrent refreshes into a single upstream fetch (single-flight)", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        })
    );
    const app = makeApp();
    // Two requests race before the first fetch resolves.
    const p1 = app.request("/api/v1/host-catalog");
    const p2 = app.request("/api/v1/host-catalog");
    await Promise.resolve();
    resolveFetch(jsonResponse(liveEnvelope()));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect((await r1.json()).source).toBe("live");
    expect((await r2.json()).source).toBe("live");
    // Both requests shared ONE upstream fetch, not two.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never serves an older out-of-order upstream envelope as fresh live", async () => {
    vi.useFakeTimers();
    try {
      const app = makeApp();
      // v3 cached first.
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...liveEnvelope(), version: 3 })
      );
      await app.request("/api/v1/host-catalog");

      // Past the TTL, a lagged upstream returns an OLDER v2. It must not be
      // served (nor cached) — the caller still gets the newer v3, and the
      // cache keeps v3.
      vi.setSystemTime(Date.now() + 301_000);
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...liveEnvelope(), version: 2 })
      );
      const res = await app.request("/api/v1/host-catalog");
      const body = await res.json();
      expect(body.version).toBe(3);
      expect(body.source).toBe("live");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // The older-response refresh must still bump the TTL — a follow-up
      // request inside the window is served from cache without re-hitting
      // upstream (no cache-thrash).
      const res2 = await app.request("/api/v1/host-catalog");
      expect((await res2.json()).version).toBe(3);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
