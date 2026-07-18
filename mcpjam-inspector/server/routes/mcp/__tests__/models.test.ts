import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// Mock the billing classifier so these tests never mutate the shared hosted
// catalog cache, and so we can assert the proxy only ingests on fresh fetches.
vi.mock("../../../services/hosted-model-catalog.js", () => ({
  ingestHostedCatalogIds: vi.fn(),
}));

import models, { __resetModelsCacheForTests } from "../models.js";
import { ingestHostedCatalogIds } from "../../../services/hosted-model-catalog.js";

const ingestMock = vi.mocked(ingestHostedCatalogIds);

function mount(): Hono {
  const app = new Hono();
  app.route("/api/mcp/models", models);
  return app;
}

const okCatalog = (items: unknown[]) =>
  new Response(JSON.stringify({ items }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("GET /api/mcp/models (catalog proxy)", () => {
  const originalFetch = global.fetch;
  const originalConvexUrl = process.env.CONVEX_HTTP_URL;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.CONVEX_HTTP_URL = "https://backend.test";
    __resetModelsCacheForTests();
    ingestMock.mockClear();
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    __resetModelsCacheForTests();
    if (originalConvexUrl === undefined) delete process.env.CONVEX_HTTP_URL;
    else process.env.CONVEX_HTTP_URL = originalConvexUrl;
    vi.useRealTimers();
  });

  it("normalizes the backend page and serves the memo within the TTL", async () => {
    fetchMock.mockResolvedValueOnce(okCatalog([{ id: "openai/gpt-4o" }]));
    const app = mount();

    const first = await app.request("/api/mcp/models");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      data: [{ id: "openai/gpt-4o" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Fresh fetch feeds the billing classifier.
    expect(ingestMock).toHaveBeenCalledTimes(1);
    expect(ingestMock).toHaveBeenCalledWith(["openai/gpt-4o"]);

    // Second request within the TTL is served from memory — no upstream call,
    // no re-ingest (the ids are unchanged).
    const second = await app.request("/api/mcp/models");
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({
      ok: true,
      data: [{ id: "openai/gpt-4o" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ingestMock).toHaveBeenCalledTimes(1);
  });

  it("returns 500 when CONVEX_HTTP_URL is not configured", async () => {
    delete process.env.CONVEX_HTTP_URL;
    const res = await mount().request("/api/mcp/models");
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 when the backend fails and there is no cached catalog", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("upstream boom", { status: 503 }),
    );
    const res = await mount().request("/api/mcp/models");
    expect(res.status).toBe(502);
    expect((await res.json()).ok).toBe(false);
  });

  it("serves the last-good catalog when the backend fails after the memo goes stale", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(okCatalog([{ id: "anthropic/claude" }]));
    const app = mount();

    const primed = await app.request("/api/mcp/models");
    expect(await primed.json()).toEqual({
      ok: true,
      data: [{ id: "anthropic/claude" }],
    });

    // Age the memo past the 60s TTL so the next request re-fetches upstream.
    vi.advanceTimersByTime(61_000);
    fetchMock.mockResolvedValueOnce(
      new Response("upstream boom", { status: 503 }),
    );

    const stale = await app.request("/api/mcp/models");
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual({
      ok: true,
      data: [{ id: "anthropic/claude" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
