/**
 * The in-process revoked-session list (MJ-011): how it reads the backend's
 * feed, when it counts as current, and what the gateway's check answers.
 *
 * The feed is the in-memory fake in `test/support/revoked-session-feed.ts`,
 * which follows the same paging contract as the backend route.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../utils/logger.js", () => ({ logger: loggerMock }));

import {
  REVOKED_SESSION_LOCAL_RETENTION_MS,
  REVOKED_SESSION_MAX_STALENESS_MS,
  REVOKED_SESSION_POLL_INTERVAL_MS,
  REVOKED_SESSIONS_FEED_PATH,
  RevokedSessionCache,
  RevokedSessionFeedError,
  activeRevokedSessionCache,
  checkSessionRevocation,
  fetchRevokedSessionFeedPage,
  markSessionRevokedLocally,
  parseRevokedSessionFeedPage,
  setRevokedSessionCacheForTests,
  type RevokedSessionFeedPage,
} from "../revoked-session-cache.js";
import { createRevokedSessionFeed } from "../../test/support/revoked-session-feed.js";

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  setRevokedSessionCacheForTests(undefined);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function cacheOn(feed: ReturnType<typeof createRevokedSessionFeed>) {
  return new RevokedSessionCache({ fetchPage: feed.fetchPage });
}

describe("RevokedSessionCache — scans", () => {
  it("loads the whole list at boot, following the cursor to the final page", async () => {
    const feed = createRevokedSessionFeed({ pageSize: 2 });
    for (const sid of ["s1", "s2", "s3", "s4", "s5"]) feed.record(sid);
    const cache = cacheOn(feed);

    await expect(cache.scan()).resolves.toBe(true);

    expect(feed.requests).toHaveLength(3);
    expect(feed.requests[0]).toEqual({ since: 0 });
    expect(feed.requests[1].cursor).toEqual(expect.any(String));
    expect(feed.requests[2].cursor).toEqual(expect.any(String));
    for (const sid of ["s1", "s2", "s3", "s4", "s5"]) {
      expect(cache.isRevoked(sid)).toBe(true);
    }
    expect(cache.isRevoked("s6")).toBe(false);
    expect(cache.state()).toMatchObject({
      initialLoadComplete: true,
      lastCompleteScanAt: T0,
      stale: false,
      size: 5,
    });
  });

  it("starts the next scan from the final page's watermark", async () => {
    const feed = createRevokedSessionFeed({ overlapMs: 60_000 });
    feed.record("s1");
    const cache = cacheOn(feed);
    await cache.scan();

    vi.setSystemTime(T0 + 15_000);
    feed.record("s2");
    await cache.scan();

    expect(feed.requests[1]).toEqual({ since: T0 - 60_000 });
    expect(cache.isRevoked("s2")).toBe(true);
    expect(cache.state()).toMatchObject({
      watermark: T0 + 15_000 - 60_000,
      lastCompleteScanAt: T0 + 15_000,
    });
  });

  it("keeps the last complete watermark and freshness when a scan fails part-way", async () => {
    const feed = createRevokedSessionFeed({ pageSize: 1 });
    feed.record("s1");
    let calls = 0;
    let failOnCall = 0;
    const cache = new RevokedSessionCache({
      fetchPage: async (request) => {
        calls += 1;
        if (calls === failOnCall) throw new Error("connection reset");
        return feed.fetchPage(request);
      },
    });
    await expect(cache.scan()).resolves.toBe(true);
    const complete = cache.state();

    vi.setSystemTime(T0 + 15_000);
    feed.record("s2");
    feed.record("s3");
    // The next scan pages s1, s2, s3; its third request fails.
    failOnCall = calls + 3;
    await expect(cache.scan()).resolves.toBe(false);

    // What the failed scan did read is refused…
    expect(cache.isRevoked("s2")).toBe(true);
    expect(cache.isRevoked("s3")).toBe(false);
    // …but neither the watermark nor the freshness clock moved.
    expect(cache.state().watermark).toBe(complete.watermark);
    expect(cache.state().lastCompleteScanAt).toBe(T0);

    // The next scan starts over from that watermark, without a cursor.
    vi.setSystemTime(T0 + 30_000);
    const next = feed.requests.length;
    await expect(cache.scan()).resolves.toBe(true);
    expect(feed.requests[next]).toEqual({ since: complete.watermark });
    expect(cache.isRevoked("s3")).toBe(true);
    expect(cache.state().lastCompleteScanAt).toBe(T0 + 30_000);
  });

  it("keeps one entry per session, with the later expiry", async () => {
    const pages: RevokedSessionFeedPage[] = [
      {
        sessions: [
          { sid: "dup", expiresAt: T0 + 50_000 },
          { sid: "dup", expiresAt: T0 + 90_000 },
        ],
        cursor: "c1",
        isDone: false,
        watermark: null,
      },
      {
        sessions: [{ sid: "dup", expiresAt: T0 + 10_000 }],
        cursor: null,
        isDone: true,
        watermark: T0 - 60_000,
      },
    ];
    const cache = new RevokedSessionCache({
      fetchPage: async () =>
        pages.shift() ?? {
          sessions: [],
          cursor: null,
          isDone: true,
          watermark: T0,
        },
    });
    await cache.scan();
    expect(cache.state().size).toBe(1);

    // Past the earlier expiries, before the latest: still refused.
    vi.setSystemTime(T0 + 60_000);
    await cache.scan();
    expect(cache.isRevoked("dup")).toBe(true);

    vi.setSystemTime(T0 + 91_000);
    await cache.scan();
    expect(cache.isRevoked("dup")).toBe(false);
  });

  it("forgets sessions once they are past their expiry", async () => {
    const feed = createRevokedSessionFeed();
    feed.record("short", { expiresAt: T0 + 20_000 });
    feed.record("long", { expiresAt: T0 + 10 * 60_000 });
    const cache = cacheOn(feed);
    await cache.scan();
    expect(cache.isRevoked("short")).toBe(true);

    vi.setSystemTime(T0 + 30_000);
    await cache.scan();

    expect(cache.isRevoked("short")).toBe(false);
    expect(cache.isRevoked("long")).toBe(true);
  });

  it("fails a scan whose feed never advances its cursor", async () => {
    const cache = new RevokedSessionCache({
      fetchPage: async () => ({
        sessions: [{ sid: "s1", expiresAt: T0 + 60_000 }],
        cursor: "same",
        isDone: false,
        watermark: null,
      }),
    });

    await expect(cache.scan()).resolves.toBe(false);
    expect(cache.state().initialLoadComplete).toBe(false);
    // What it read is still refused.
    expect(cache.isRevoked("s1")).toBe(true);
  });

  it("joins a scan already in flight instead of starting a second", async () => {
    const feed = createRevokedSessionFeed();
    const cache = cacheOn(feed);
    const [a, b] = await Promise.all([cache.scan(), cache.scan()]);
    expect(a && b).toBe(true);
    expect(feed.requests).toHaveLength(1);
  });
});

describe("RevokedSessionCache — polling and freshness", () => {
  it("polls every interval after the initial load", async () => {
    const feed = createRevokedSessionFeed();
    const cache = cacheOn(feed);
    cache.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.requests).toHaveLength(1);
    expect(cache.state().initialLoadComplete).toBe(true);

    feed.record("later");
    await vi.advanceTimersByTimeAsync(REVOKED_SESSION_POLL_INTERVAL_MS);

    expect(feed.requests).toHaveLength(2);
    expect(cache.isRevoked("later")).toBe(true);
    cache.stop();
  });

  it("retries a failed initial load sooner than the poll interval, and completes it later", async () => {
    const feed = createRevokedSessionFeed();
    feed.record("s1");
    feed.failNext(2);
    const cache = cacheOn(feed);
    cache.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.state().initialLoadComplete).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000 + 2_000);

    expect(cache.state().initialLoadComplete).toBe(true);
    expect(cache.isRevoked("s1")).toBe(true);
    cache.stop();
  });

  it("goes stale once the last complete scan is older than the limit, and reports it once", async () => {
    const feed = createRevokedSessionFeed();
    feed.record("known");
    const cache = cacheOn(feed);
    cache.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.isFresh()).toBe(true);

    feed.failNext(100);
    await vi.advanceTimersByTimeAsync(REVOKED_SESSION_MAX_STALENESS_MS);
    expect(cache.isFresh()).toBe(true);
    await vi.advanceTimersByTimeAsync(REVOKED_SESSION_POLL_INTERVAL_MS);

    expect(cache.isFresh()).toBe(false);
    expect(cache.state().stale).toBe(true);
    // Known revocations outlive the outage.
    expect(cache.isRevoked("known")).toBe(true);
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(RevokedSessionFeedError),
      expect.objectContaining({ event: "auth.revoked_sessions.stale" }),
    );

    await vi.advanceTimersByTimeAsync(5 * REVOKED_SESSION_POLL_INTERVAL_MS);
    expect(loggerMock.error).toHaveBeenCalledTimes(1);
    cache.stop();
  });

  it("is current again after the next complete scan", async () => {
    const feed = createRevokedSessionFeed();
    const cache = cacheOn(feed);
    await cache.scan();
    vi.setSystemTime(T0 + REVOKED_SESSION_MAX_STALENESS_MS + 1);
    expect(cache.isFresh()).toBe(false);

    await cache.scan();

    expect(cache.isFresh()).toBe(true);
  });

  it("remembers a locally marked session ahead of the feed", () => {
    const cache = cacheOn(createRevokedSessionFeed());
    cache.markRevokedLocally("local");
    expect(cache.isRevoked("local")).toBe(true);

    vi.setSystemTime(T0 + REVOKED_SESSION_LOCAL_RETENTION_MS - 1);
    expect(cache.isRevoked("local")).toBe(true);
  });
});

describe("parseRevokedSessionFeedPage", () => {
  it("accepts a final page and an unfinished one", () => {
    expect(
      parseRevokedSessionFeedPage({
        sessions: [{ sid: "a", revokedAt: 1, expiresAt: 2 }],
        cursor: null,
        isDone: true,
        watermark: 5,
      }),
    ).toEqual({
      sessions: [{ sid: "a", expiresAt: 2 }],
      cursor: null,
      isDone: true,
      watermark: 5,
    });
    expect(
      parseRevokedSessionFeedPage({
        sessions: [],
        cursor: "next",
        isDone: false,
        watermark: null,
      }).cursor,
    ).toBe("next");
  });

  it.each([
    ["no sessions array", { cursor: null, isDone: true, watermark: 1 }],
    ["a final page with no watermark", { sessions: [], isDone: true }],
    ["an unfinished page with no cursor", { sessions: [], isDone: false }],
    ["a non-object", "nope"],
  ])("refuses %s", (_label, body) => {
    expect(() => parseRevokedSessionFeedPage(body)).toThrow(
      RevokedSessionFeedError,
    );
  });

  it("skips rows without a session id and keeps rows without an expiry", () => {
    const page = parseRevokedSessionFeedPage({
      sessions: [{ expiresAt: 5 }, { sid: "" }, { sid: "kept" }],
      cursor: null,
      isDone: true,
      watermark: 1,
    });
    expect(page.sessions).toEqual([{ sid: "kept" }]);
  });
});

describe("fetchRevokedSessionFeedPage", () => {
  it("reads the feed with the service token, passing since and cursor", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example/");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
    const fetchMock = vi.fn(async () =>
      Response.json({
        sessions: [{ sid: "a", revokedAt: 1, expiresAt: 2 }],
        cursor: null,
        isDone: true,
        watermark: 9,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const page = await fetchRevokedSessionFeedPage({ since: 42, cursor: "c" });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.origin + url.pathname).toBe(
      `https://backend.example${REVOKED_SESSIONS_FEED_PATH}`,
    );
    expect(url.searchParams.get("since")).toBe("42");
    expect(url.searchParams.get("cursor")).toBe("c");
    expect(init.headers).toMatchObject({
      "x-inspector-service-token": "svc-token",
    });
    expect(page.watermark).toBe(9);
  });

  it("turns a refusal into a feed error carrying status and code", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.example");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: "bad cursor", code: "INVALID_CURSOR" },
          { status: 400 },
        ),
      ),
    );

    await expect(
      fetchRevokedSessionFeedPage({ since: 0, cursor: "stale" }),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_CURSOR" });
  });
});

describe("checkSessionRevocation", () => {
  it("passes everything where no feed is configured", () => {
    vi.stubEnv("CONVEX_HTTP_URL", "");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    expect(activeRevokedSessionCache()).toBeNull();
    expect(checkSessionRevocation("any", { requireFresh: true })).toEqual({
      ok: true,
    });
    expect(checkSessionRevocation(undefined, { requireFresh: true })).toEqual({
      ok: true,
    });
    // Marking is a no-op there too.
    markSessionRevokedLocally("any");
    expect(checkSessionRevocation("any", { requireFresh: false })).toEqual({
      ok: true,
    });
  });

  it("refuses a known revoked session whatever the freshness", async () => {
    const cache = cacheOn(createRevokedSessionFeed());
    setRevokedSessionCacheForTests(cache);
    cache.markRevokedLocally("gone");

    // Not loaded yet, so not fresh — a known revocation still wins.
    expect(checkSessionRevocation("gone", { requireFresh: true })).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(checkSessionRevocation("gone", { requireFresh: false })).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("refuses an unknown session only when freshness is required and missing", async () => {
    const cache = cacheOn(createRevokedSessionFeed());
    setRevokedSessionCacheForTests(cache);

    expect(checkSessionRevocation("s", { requireFresh: true })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(checkSessionRevocation("s", { requireFresh: false })).toEqual({
      ok: true,
    });

    await cache.scan();
    expect(checkSessionRevocation("s", { requireFresh: true })).toEqual({
      ok: true,
    });
  });

  it("refuses a token without a session id only where the list alone decides", async () => {
    const cache = cacheOn(createRevokedSessionFeed());
    setRevokedSessionCacheForTests(cache);
    await cache.scan();

    for (const sid of [undefined, null, ""]) {
      expect(checkSessionRevocation(sid, { requireFresh: true })).toEqual({
        ok: false,
        reason: "no_session",
      });
      expect(checkSessionRevocation(sid, { requireFresh: false })).toEqual({
        ok: true,
      });
    }
  });
});

describe("startRevokedSessionCache without a feed", () => {
  /** A fresh copy of the module, as a process started with `hosted` would load it. */
  async function processStartedWithoutFeed(hosted: boolean) {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", hosted ? "true" : "false");
    vi.stubEnv("CONVEX_HTTP_URL", "");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    vi.resetModules();
    const module = await import("../revoked-session-cache.js");
    module.startRevokedSessionCache();
    return module;
  }

  it("refuses on the routes that rely on the list in a hosted process", async () => {
    const hosted = await processStartedWithoutFeed(true);

    expect(hosted.activeRevokedSessionCache()?.state()).toMatchObject({
      initialLoadComplete: false,
      stale: true,
      running: false,
    });
    expect(hosted.checkSessionRevocation("s", { requireFresh: true })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(hosted.checkSessionRevocation("s", { requireFresh: false })).toEqual(
      { ok: true },
    );

    // A sign-out on this process is still refused everywhere.
    hosted.markSessionRevokedLocally("gone");
    expect(
      hosted.checkSessionRevocation("gone", { requireFresh: false }),
    ).toEqual({ ok: false, reason: "revoked" });

    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining("Revoked-session list cannot load"),
      expect.any(Error),
      { event: "auth.revoked_sessions.disabled" },
    );
  });

  it("changes nothing in a local process", async () => {
    const local = await processStartedWithoutFeed(false);

    expect(local.activeRevokedSessionCache()).toBeNull();
    expect(local.checkSessionRevocation("s", { requireFresh: true })).toEqual({
      ok: true,
    });
    expect(
      local.checkSessionRevocation(undefined, { requireFresh: true }),
    ).toEqual({ ok: true });
    expect(loggerMock.error).not.toHaveBeenCalled();
  });
});
