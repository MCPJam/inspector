import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The score relay is the one place a result link is minted and redeemed.
 *
 * Two properties matter most and are asserted here: a submission is bounded
 * and validated before it reaches Convex, and a READ works with no session
 * whatsoever — a shared result must open in an incognito window, because the
 * token in the URL is the entire credential.
 */

const SUMMARY = {
  score: 82,
  outcome: "failed" as const,
  applicable: 40,
  passed: 33,
  failed: 6,
  couldNotRun: 1,
  notApplicable: 12,
  advisoryCount: 2,
  protocolVersion: "2025-06-18",
};

/**
 * Fresh module per test: the rate-limit and result-cache maps are module
 * state. `errors` is re-imported from the SAME reset registry — a
 * `WebRouteError` thrown by the freshly-loaded route is not an instance of a
 * stale registry's class, and every status would flatten to 500.
 */
async function freshApp() {
  vi.resetModules();
  const [{ default: scoreRoutes }, { mapRuntimeError, webError }] =
    await Promise.all([import("../score"), import("../errors")]);

  const app = new Hono();
  app.route("/api/web/score", scoreRoutes);
  app.onError((error, c) => {
    const routeError = mapRuntimeError(error);
    return webError(c, routeError.status, routeError.code, routeError.message);
  });
  return app;
}

function submitBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    serverUrl: "https://mcp.example.com/mcp",
    summary: SUMMARY,
    suiteSummaries: [{ suiteId: "protocol", ...SUMMARY }],
    report: { protocol: { checks: [] } },
    ...overrides,
  });
}

const originalFetch = global.fetch;
const originalConvexUrl = process.env.CONVEX_HTTP_URL;
const originalServiceToken = process.env.INSPECTOR_SERVICE_TOKEN;

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://convex.test";
  process.env.INSPECTOR_SERVICE_TOKEN = "svc-tok";
});

afterEach(() => {
  global.fetch = originalFetch;
  if (originalConvexUrl === undefined) delete process.env.CONVEX_HTTP_URL;
  else process.env.CONVEX_HTTP_URL = originalConvexUrl;
  if (originalServiceToken === undefined)
    delete process.env.INSPECTOR_SERVICE_TOKEN;
  else process.env.INSPECTOR_SERVICE_TOKEN = originalServiceToken;
  vi.restoreAllMocks();
});

describe("POST /api/web/score/runs", () => {
  it("relays to Convex with the service token and returns the link token", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, token: "tok_abc" }, { status: 200 })
    );
    global.fetch = fetchMock as any;

    const app = await freshApp();
    const res = await app.request("/api/web/score/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: submitBody(),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, token: "tok_abc" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://convex.test/internal/v1/score/runs");
    expect(
      (init.headers as Record<string, string>)["x-inspector-service-token"]
    ).toBe("svc-tok");
  });

  it("400s a malformed summary without calling Convex", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as any;

    const app = await freshApp();
    const res = await app.request("/api/web/score/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: submitBody({ summary: { ...SUMMARY, outcome: "mostly-fine" } }),
    });

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400s more than four suite summaries", async () => {
    const app = await freshApp();
    const res = await app.request("/api/web/score/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: submitBody({
        suiteSummaries: Array.from({ length: 5 }, () => ({
          suiteId: "protocol",
          ...SUMMARY,
        })),
      }),
    });
    expect(res.status).toBe(400);
  });

  it("429s once the per-IP window is spent", async () => {
    global.fetch = vi.fn(async () =>
      Response.json({ ok: true, token: "tok" }, { status: 200 })
    ) as any;

    const app = await freshApp();
    const submit = () =>
      app.request("/api/web/score/runs", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-real-ip": "203.0.113.9",
        },
        body: submitBody(),
      });

    for (let i = 0; i < 10; i++) {
      expect((await submit()).status).toBe(200);
    }
    expect((await submit()).status).toBe(429);
  });

  it("keeps each IP on its own budget", async () => {
    // Guards the failure where the key collapses to a constant (or to
    // getClientIp's null fallback) and one busy client throttles everyone
    // behind the same edge.
    global.fetch = vi.fn(async () =>
      Response.json({ ok: true, token: "tok" }, { status: 200 })
    ) as any;

    const app = await freshApp();
    const submitFrom = (ip: string) =>
      app.request("/api/web/score/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": ip },
        body: submitBody(),
      });

    for (let i = 0; i < 10; i++) {
      expect((await submitFrom("198.51.100.1")).status).toBe(200);
    }
    expect((await submitFrom("198.51.100.1")).status).toBe(429);
    // A different address is untouched by the first one's exhausted window.
    expect((await submitFrom("198.51.100.2")).status).toBe(200);
  });

  it("400s a report that is not an object", async () => {
    // A stored `null` would mint a working link to a page that throws on open.
    const app = await freshApp();
    for (const report of [null, "nope", 42, []]) {
      const res = await app.request("/api/web/score/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: submitBody({ report }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("503s when storage is not configured, rather than silently dropping a run", async () => {
    delete process.env.INSPECTOR_SERVICE_TOKEN;
    const app = await freshApp();
    const res = await app.request("/api/web/score/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: submitBody(),
    });
    expect(res.status).toBe(503);
  });
});

describe("GET /api/web/score/runs/:token", () => {
  it("reads a run with no session, cookie, or bearer of any kind", async () => {
    global.fetch = vi.fn(async () =>
      Response.json(
        {
          ok: true,
          run: { serverUrl: "https://mcp.example.com/mcp", score: 82 },
        },
        { status: 200 }
      )
    ) as any;

    const app = await freshApp();
    // No Authorization header, no Cookie — an incognito visitor.
    const res = await app.request("/api/web/score/runs/tok_abc");

    expect(res.status).toBe(200);
    expect((await res.json()).run.score).toBe(82);
  });

  it("caches a repeat read instead of re-hitting Convex", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ ok: true, run: { score: 82 } }, { status: 200 })
    );
    global.fetch = fetchMock as any;

    const app = await freshApp();
    await app.request("/api/web/score/runs/tok_abc");
    await app.request("/api/web/score/runs/tok_abc");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("404s an unknown token with a message a human can act on", async () => {
    global.fetch = vi.fn(async () =>
      Response.json({ ok: false }, { status: 404 })
    ) as any;

    const app = await freshApp();
    const res = await app.request("/api/web/score/runs/nope");

    expect(res.status).toBe(404);
    expect((await res.json()).message).toMatch(/not valid/);
  });

  it("charges only cache MISSES, and 429s a token guesser", async () => {
    // A wrong token 404s and never populates the cache, so without a budget
    // every guess is a free Convex round trip aimed at our own backend.
    global.fetch = vi.fn(async () =>
      Response.json({ ok: false }, { status: 404 })
    ) as any;

    const app = await freshApp();
    const guess = (n: number) =>
      app.request(`/api/web/score/runs/guess-${n}`, {
        headers: { "x-real-ip": "203.0.113.77" },
      });

    for (let i = 0; i < 60; i++) {
      expect((await guess(i)).status).toBe(404);
    }
    expect((await guess(999)).status).toBe(429);
  });

  it("does not charge a cached read against the budget", async () => {
    global.fetch = vi.fn(async () =>
      Response.json({ ok: true, run: { score: 82 } }, { status: 200 })
    ) as any;

    const app = await freshApp();
    // One miss populates the cache; the rest are served from it, so a popular
    // link can be opened far more often than the miss budget allows.
    for (let i = 0; i < 100; i++) {
      const res = await app.request("/api/web/score/runs/popular", {
        headers: { "x-real-ip": "203.0.113.88" },
      });
      expect(res.status).toBe(200);
    }
  });

  it("502s when Convex is unreachable", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;

    const app = await freshApp();
    expect((await app.request("/api/web/score/runs/tok")).status).toBe(502);
  });
});
