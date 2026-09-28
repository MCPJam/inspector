/**
 * `GET /api/web/flags` verifies its own bearer, so it applies the gateway's
 * revoked-session check itself (MJ-011): a signed-out AuthKit session gets the
 * same `401 SESSION_REVOKED` every other `/api/web` route answers, and its
 * flags are not evaluated.
 *
 * The revoked-session list is a real `RevokedSessionCache` reading the
 * in-memory feed in `test/support/revoked-session-feed.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const SESSIONS = vi.hoisted(
  (): Record<string, { sub: string; sid?: string }> => ({
    "token-alice": { sub: "user_alice", sid: "session_alice" },
    "token-bob": { sub: "user_bob", sid: "session_bob" },
    "token-carol": { sub: "user_carol" },
  }),
);

const mocks = vi.hoisted(() => ({ getAllFlags: vi.fn() }));

vi.mock("posthog-node", () => ({
  PostHog: vi.fn(() => ({
    getAllFlags: mocks.getAllFlags,
    capture: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: vi.fn(async (token: string) =>
    token.startsWith("guest-")
      ? { valid: true, guestId: token }
      : { valid: false, reason: "not_guest" },
  ),
}));

vi.mock("../../../services/authkit-jwt.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../services/authkit-jwt.js")>();
  return {
    ...actual,
    verifyAuthKitToken: vi.fn(async (token: string) => {
      const session = SESSIONS[token];
      if (!session) {
        throw new actual.AuthKitVerificationError("unknown test token");
      }
      return { ...session };
    }),
  };
});

vi.mock("../../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config.js")>()),
  HOSTED_MODE: true,
}));

import clientFlags, { resetClientFlagsRateLimitForTests } from "../flags.js";
import { shutdownAnalytics } from "../../../utils/analytics.js";
import {
  RevokedSessionCache,
  setRevokedSessionCacheForTests,
} from "../../../services/revoked-session-cache.js";
import { createRevokedSessionFeed } from "../../../test/support/revoked-session-feed.js";

let feed: ReturnType<typeof createRevokedSessionFeed>;

const app = new Hono();
app.route("/api/web/flags", clientFlags);

const getFlags = (token: string) =>
  app.request("/api/web/flags", {
    headers: {
      Authorization: `Bearer ${token}`,
      "cf-connecting-ip": "203.0.113.9",
    },
  });

/** Serve with a list that has finished its first load. */
async function serveWithList(): Promise<RevokedSessionCache> {
  const cache = new RevokedSessionCache({ fetchPage: feed.fetchPage });
  await expect(cache.scan()).resolves.toBe(true);
  setRevokedSessionCacheForTests(cache);
  return cache;
}

beforeEach(() => {
  feed = createRevokedSessionFeed();
  resetClientFlagsRateLimitForTests();
  mocks.getAllFlags.mockReset().mockResolvedValue({ xaa: true });
});

afterEach(async () => {
  setRevokedSessionCacheForTests(undefined);
  await shutdownAnalytics();
});

describe("GET /api/web/flags — signed-out sessions (MJ-011)", () => {
  it("answers 401 SESSION_REVOKED for a revoked session and evaluates nothing", async () => {
    feed.record("session_alice");
    await serveWithList();

    const response = await getFlags("token-alice");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "SESSION_REVOKED" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getAllFlags).not.toHaveBeenCalled();
  });

  it("still answers a live session with its own flags", async () => {
    feed.record("session_alice");
    await serveWithList();

    const response = await getFlags("token-bob");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ flags: { xaa: true } });
    expect(mocks.getAllFlags.mock.calls[0][0]).toBe("user_bob");
  });

  it("refuses a session revoked after it was first served", async () => {
    const cache = await serveWithList();
    expect((await getFlags("token-alice")).status).toBe(200);

    feed.record("session_alice");
    await cache.scan();

    expect((await getFlags("token-alice")).status).toBe(401);
  });

  it("refuses a session this process marked signed out before the feed has it", async () => {
    const cache = await serveWithList();
    cache.markRevokedLocally("session_alice");

    expect((await getFlags("token-alice")).status).toBe(401);
  });

  it("serves tokens the list cannot name, and guests, as before", async () => {
    feed.record("session_alice");
    await serveWithList();

    // No `sid` claim: the gateway passes these through too.
    expect((await getFlags("token-carol")).status).toBe(200);
    expect((await getFlags("guest-abc")).status).toBe(200);
    expect(mocks.getAllFlags.mock.calls.map((call) => call[0])).toEqual([
      "user_carol",
      "guest-abc",
    ]);
  });

  it("serves everything where no list is configured (local installs)", async () => {
    setRevokedSessionCacheForTests(null);

    expect((await getFlags("token-alice")).status).toBe(200);
  });
});
