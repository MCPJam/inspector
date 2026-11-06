import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import conformanceShareCard from "../conformance-share-card.js";
import {
  cardDataFromPreview,
  clearConformanceShareCardCache,
} from "../../../services/conformance-share-card/link-preview.js";
import {
  SHARE_CARD_LOOKUP_LIMIT,
  resetShareCardLookupLimit,
} from "../../../services/conformance-share-card/lookup-limit.js";

// With no edge attestation or trusted header configured, Cloudflare's
// address is the one the limiter vouches for.
const FROM_A = { "cf-connecting-ip": "203.0.113.7" };
const FROM_B = { "cf-connecting-ip": "203.0.113.8" };

/** A distinct, valid link token for each `n`. */
function tokenFor(n: number): string {
  return `invented_token_${String(n).padStart(6, "0")}`;
}

const TOKEN = "V1StGXR8_Z5jdHi6B-myT";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

const PREVIEW = {
  score: 85.7,
  outcome: "incomplete",
  applicable: 28,
  passed: 24,
  failed: 0,
  couldNotRun: 4,
  notApplicable: 2,
  advisoryCount: 0,
  protocolVersion: "2025-11-25",
  createdAt: 1_762_300_000_000,
  suites: [
    { kind: "protocol", applicable: 16, passed: 16, failed: 0, couldNotRun: 0 },
    { kind: "tasks", applicable: 5, passed: 1, failed: 0, couldNotRun: 4 },
  ],
};

function app() {
  const root = new Hono();
  root.route("/api/web/conformance-share-card", conformanceShareCard);
  return root;
}

describe("GET /api/web/conformance-share-card/:token.png", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    clearConformanceShareCardCache();
    resetShareCardLookupLimit();
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example.test");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("draws the card for a link anyone may open", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true, preview: PREVIEW }));

    const res = await app().request(
      `/api/web/conformance-share-card/${TOKEN}.png`,
      { headers: { Host: "app.mcpjam.com" } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual(PNG_SIGNATURE);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://backend.example.test/web/share/preview");
    // The token rides in the body, never the URL.
    expect(String(url)).not.toContain(TOKEN);
    expect(JSON.parse(init.body)).toEqual({
      resourceType: "conformanceRun",
      token: TOKEN,
    });
  }, 30_000);

  it("is a 404 for a link the backend will not preview", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: false }, { status: 404 }));
    const res = await app().request(
      `/api/web/conformance-share-card/${TOKEN}.png`,
    );
    expect(res.status).toBe(404);
  });

  it("asks the backend once while the answer is fresh", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: false }, { status: 404 }));
    await app().request(`/api/web/conformance-share-card/${TOKEN}.png`);
    await app().request(`/api/web/conformance-share-card/${TOKEN}.png`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops asking the backend once an address spends its lookup budget", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ ok: false }, { status: 404 }),
    );
    for (let n = 0; n < SHARE_CARD_LOOKUP_LIMIT; n++) {
      const res = await app().request(
        `/api/web/conformance-share-card/${tokenFor(n)}.png`,
        { headers: FROM_A },
      );
      expect(res.status).toBe(404);
    }

    const limited = await app().request(
      `/api/web/conformance-share-card/${tokenFor(SHARE_CARD_LOOKUP_LIMIT)}.png`,
      { headers: FROM_A },
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("600");
    expect(fetchMock).toHaveBeenCalledTimes(SHARE_CARD_LOOKUP_LIMIT);

    // Another address has its own budget.
    const other = await app().request(
      `/api/web/conformance-share-card/${tokenFor(SHARE_CARD_LOOKUP_LIMIT)}.png`,
      { headers: FROM_B },
    );
    expect(other.status).toBe(404);
  });

  it("serves a cached card even after the budget is spent", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ ok: false }, { status: 404 }),
    );
    // Cache the answer for one token, then spend the rest of the budget.
    await app().request(`/api/web/conformance-share-card/${TOKEN}.png`, {
      headers: FROM_A,
    });
    for (let n = 1; n < SHARE_CARD_LOOKUP_LIMIT; n++) {
      await app().request(
        `/api/web/conformance-share-card/${tokenFor(n)}.png`,
        {
          headers: FROM_A,
        },
      );
    }

    const cached = await app().request(
      `/api/web/conformance-share-card/${TOKEN}.png`,
      { headers: FROM_A },
    );
    expect(cached.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(SHARE_CARD_LOOKUP_LIMIT);
  });

  it("does not cache a backend that did not answer", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce(Response.json({ ok: false }, { status: 404 }));

    const down = await app().request(
      `/api/web/conformance-share-card/${TOKEN}.png`,
    );
    expect(down.status).toBe(503);
    expect(down.headers.get("cache-control")).toBe("no-store");

    const back = await app().request(
      `/api/web/conformance-share-card/${TOKEN}.png`,
    );
    expect(back.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a backend 5xx as unavailable, not as no card", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 502 }));
    const res = await app().request(
      `/api/web/conformance-share-card/${TOKEN}.png`,
    );
    expect(res.status).toBe(503);
  });

  it("does not let a made-up host mint new cache entries", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ ok: false }, { status: 404 }),
    );
    for (const host of ["a.evil.test", "b.evil.test", "c.evil.test"]) {
      await app().request(`/api/web/conformance-share-card/${TOKEN}.png`, {
        headers: { "X-Forwarded-Host": host },
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses anything that is not a link token", async () => {
    const res = await app().request(
      "/api/web/conformance-share-card/not..a.token.png",
    );
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("cardDataFromPreview", () => {
  it("never carries a server name into a public card", () => {
    expect(
      cardDataFromPreview(PREVIEW, "app.mcpjam.com")?.serverName,
    ).toBeNull();
  });

  it("has no card for a run without a score or applicable checks", () => {
    expect(cardDataFromPreview({ ...PREVIEW, score: null }, null)).toBeNull();
    expect(cardDataFromPreview({ ...PREVIEW, applicable: 0 }, null)).toBeNull();
  });
});
