/**
 * Session revocation end to end, through the real `/api/v1` and `/api/web`
 * routers (MJ-011).
 *
 * Once a session is revoked — signed out on a replica, or recorded by the
 * backend from the identity provider — the SAME bearer is refused on:
 *
 *   - `GET /api/v1/me`              a route that forwards the bearer to Convex;
 *   - `POST /api/web/api-keys`      API-key management;
 *   - `GET /api/v1/agent-ops`       a `requireVerifiedAuth` route.
 *
 * The backend is an in-memory stand-in: `test/support/revoked-session-feed.ts`
 * is its revoked-session store and feed, and `authSessions:revokeCurrentSession`
 * (reached through the Convex client) writes to it. Each "replica" is its own
 * `RevokedSessionCache` reading that feed; the active one is swapped in with
 * `setRevokedSessionCacheForTests`, so the same routers serve as any replica.
 * Token verification is mocked to a fixed table of sessions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/** The bearers this test verifies, and the session each belongs to. */
const SESSIONS = vi.hoisted(
  (): Record<string, { sub: string; sid?: string }> => ({
    "token-alice": { sub: "user_alice", sid: "session_alice" },
    "token-bob": { sub: "user_bob", sid: "session_bob" },
    "token-carol": { sub: "user_carol" },
  }),
);

const backend = vi.hoisted(() => ({
  mode: "ok" as "ok" | "hang" | "fail",
  revokeCurrentSession: undefined as
    undefined | ((token: string | undefined) => Promise<unknown>),
}));

vi.mock("../services/authkit-jwt.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/authkit-jwt.js")>();
  return {
    ...actual,
    classifyAuthKitBearer: vi.fn(async (token: string) => {
      const session = SESSIONS[token];
      return session
        ? { kind: "verified", ...session }
        : { kind: "not_authkit" };
    }),
    verifyAuthKitToken: vi.fn(async (token: string) => {
      const session = SESSIONS[token];
      if (!session) {
        throw new actual.AuthKitVerificationError("unknown test token");
      }
      return { ...session };
    }),
  };
});

vi.mock("../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: vi.fn(async () => ({
    valid: false,
    reason: "not_guest",
  })),
}));

vi.mock("../services/identity.js", () => ({
  resolveUserByExternalId: vi.fn(async (externalId: string) => ({
    _id: `convex_${externalId}`,
  })),
}));

vi.mock("../services/organizations.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveApiKeyReadiness: vi.fn(async () => ({
    ready: true,
    workosOrganizationId: "org_workos_1",
    mintAllowed: true,
    mintMinimumRole: "member",
  })),
}));

vi.mock("../services/workos-key-bindings.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createWorkosKeyBinding: vi.fn(async () => undefined),
  lookupWorkosKeyBinding: vi.fn(async () => null),
}));

// `authSessions:revokeCurrentSession`, called as the bearer being signed out.
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    private token: string | undefined;
    setAuth(token: string) {
      this.token = token;
    }
    async mutation() {
      return backend.revokeCurrentSession!(this.token);
    }
  },
}));

import { requestLogContextMiddleware } from "../middleware/request-log-context.js";
import v1Routes from "../routes/v1/index.js";
import webRoutes from "../routes/web/index.js";
import {
  REVOKED_SESSION_MAX_STALENESS_MS,
  RevokedSessionCache,
  setRevokedSessionCacheForTests,
} from "../services/revoked-session-cache.js";
import {
  SESSION_REVOCATION_RETRY_DELAYS_MS,
  SESSION_REVOCATION_TIMEOUT_MS,
  resetSessionRevocationRetriesForTests,
} from "../services/auth-session-revocation.js";
import { createRevokedSessionFeed } from "../test/support/revoked-session-feed.js";

let feed: ReturnType<typeof createRevokedSessionFeed>;

function createApp(): Hono {
  const app = new Hono();
  app.use("/api/*", requestLogContextMiddleware);
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = {};
    await next();
  });
  app.route("/api/v1", v1Routes);
  app.route("/api/web", webRoutes);
  return app;
}

const app = createApp();

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const me = (token: string) =>
  app.request("/api/v1/me", { headers: auth(token) });

const agentOps = (token: string) =>
  app.request("/api/v1/agent-ops", { headers: auth(token) });

const mintKey = (token: string) =>
  app.request("/api/web/api-keys", {
    method: "POST",
    headers: { ...auth(token), "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ci", organizationId: "org_convex_1" }),
  });

const signOut = (token: string) =>
  app.request("/api/web/auth-session/revoke", {
    method: "POST",
    headers: auth(token),
  });

/** A replica whose list has completed its initial load. */
async function bootedReplica(): Promise<RevokedSessionCache> {
  const replica = new RevokedSessionCache({ fetchPage: feed.fetchPage });
  await expect(replica.scan()).resolves.toBe(true);
  return replica;
}

function serveAs(replica: RevokedSessionCache): void {
  setRevokedSessionCacheForTests(replica);
}

async function expectRevokedV1(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({
    code: "UNAUTHORIZED",
    details: { reason: "SESSION_REVOKED" },
  });
}

async function expectRevokedWeb(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: "SESSION_REVOKED" });
}

async function expectRetryable503(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  expect(response.headers.get("Retry-After")).toBe("5");
  expect(await response.json()).toMatchObject({
    code: "SERVER_UNREACHABLE",
    details: { reason: "SESSION_CHECK_UNAVAILABLE" },
  });
}

/** `/api/v1` answers with the status its contract gives `SERVER_UNREACHABLE`. */
async function expectRetryableV1(response: Response): Promise<void> {
  expect(response.status).toBe(502);
  expect(response.headers.get("Retry-After")).toBe("5");
  expect(await response.json()).toMatchObject({
    code: "SERVER_UNREACHABLE",
    details: { reason: "SESSION_CHECK_UNAVAILABLE" },
  });
}

async function expectRevokedEverywhere(token: string): Promise<void> {
  await expectRevokedV1(await me(token));
  await expectRevokedWeb(await mintKey(token));
  await expectRevokedV1(await agentOps(token));
}

async function expectServedEverywhere(token: string): Promise<void> {
  expect((await me(token)).status).toBe(200);
  expect((await mintKey(token)).status).toBe(200);
  expect((await agentOps(token)).status).toBe(200);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 8, 1, 12, 0, 0));
  vi.stubEnv("CONVEX_HTTP_URL", "https://revocation-test.convex.site");
  vi.stubEnv("WORKOS_API_KEY", "sk_test_admin");
  feed = createRevokedSessionFeed();
  backend.mode = "ok";
  backend.revokeCurrentSession = async (token) => {
    if (backend.mode === "hang") return new Promise(() => {});
    if (backend.mode === "fail") throw new Error("backend unavailable");
    const sid = token ? SESSIONS[token]?.sid : undefined;
    if (!sid) return { revoked: false, reason: "no_identity" };
    if (!feed.rows.some((row) => row.sid === sid)) {
      feed.record(sid);
    }
    return { revoked: true };
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/me") {
        return Response.json({ id: "convex_user" });
      }
      if (
        init?.method === "POST" &&
        /^\/user_management\/users\/[^/]+\/api_keys$/.test(url.pathname)
      ) {
        return Response.json(
          { id: "api_key_new", name: "ci", value: "sk_test_value" },
          { status: 201 },
        );
      }
      return Response.json({ message: "unexpected call" }, { status: 500 });
    }),
  );
});

afterEach(() => {
  resetSessionRevocationRetriesForTests();
  setRevokedSessionCacheForTests(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("session revocation across route families (MJ-011)", () => {
  it("refuses a session signed out on this replica, on every route family", async () => {
    serveAs(await bootedReplica());
    await expectServedEverywhere("token-alice");

    const res = await signOut("token-alice");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    await expectRevokedEverywhere("token-alice");
    // Another session of the same deployment is unaffected.
    await expectServedEverywhere("token-bob");
  });

  it("refuses a session the backend recorded as revoked by the identity provider, after one poll", async () => {
    const replica = new RevokedSessionCache({ fetchPage: feed.fetchPage });
    serveAs(replica);
    replica.start();
    await vi.advanceTimersByTimeAsync(0);
    await expectServedEverywhere("token-alice");

    // A provider-side revocation (an admin ending the session, or one found by
    // reconciling the provider's event list) lands in the backend's store.
    feed.record("session_alice");
    await vi.advanceTimersByTimeAsync(15_000);

    await expectRevokedEverywhere("token-alice");
    await expectServedEverywhere("token-bob");
    replica.stop();
  });

  it("refuses a session signed out on another replica once this one has polled", async () => {
    const replicaA = await bootedReplica();
    const replicaB = await bootedReplica();

    serveAs(replicaA);
    expect(await (await signOut("token-alice")).json()).toEqual({
      revoked: true,
    });

    serveAs(replicaB);
    await replicaB.scan();
    await expectRevokedEverywhere("token-alice");
  });

  it("refuses the session after a restart, once the full initial load completes", async () => {
    serveAs(await bootedReplica());
    await signOut("token-alice");

    const restarted = new RevokedSessionCache({ fetchPage: feed.fetchPage });
    serveAs(restarted);
    // Until the initial load completes, routes that rely on the list alone
    // answer a retryable refusal; a known-revoked answer needs the load.
    await expectRetryable503(await mintKey("token-alice"));
    await expectRetryableV1(await agentOps("token-alice"));

    const firstRequest = feed.requests.length;
    await restarted.scan();

    expect(feed.requests[firstRequest]).toEqual({ since: 0 });
    await expectRevokedEverywhere("token-alice");
  });

  it("answers 503 on key management until a failed initial load succeeds on retry", async () => {
    feed.failNext(1);
    const replica = new RevokedSessionCache({ fetchPage: feed.fetchPage });
    serveAs(replica);
    replica.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(replica.state().initialLoadComplete).toBe(false);

    await expectRetryable503(await mintKey("token-bob"));
    await expectRetryableV1(await agentOps("token-bob"));
    // A route that forwards the bearer to Convex keeps serving: Convex checks
    // the session against the durable record itself.
    expect((await me("token-bob")).status).toBe(200);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(replica.state().initialLoadComplete).toBe(true);
    await expectServedEverywhere("token-bob");
    replica.stop();
  });

  it("reports an unacknowledged sign-out as pending, refuses it here at once, and records it on retry", async () => {
    serveAs(await bootedReplica());
    backend.mode = "hang";

    const pending = signOut("token-alice");
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_TIMEOUT_MS);
    const res = await pending;

    expect(await res.json()).toEqual({
      revoked: false,
      reason: "timeout",
      status: "pending",
    });
    await expectRevokedEverywhere("token-alice");
    expect(feed.rows.map((row) => row.sid)).not.toContain("session_alice");

    backend.mode = "ok";
    await vi.advanceTimersByTimeAsync(SESSION_REVOCATION_RETRY_DELAYS_MS[0]);

    expect(feed.rows.map((row) => row.sid)).toContain("session_alice");
    // …which is what another replica learns it from.
    serveAs(await bootedReplica());
    await expectRevokedEverywhere("token-alice");
  });

  it("reports a failed durable write as not revoked", async () => {
    serveAs(await bootedReplica());
    backend.mode = "fail";

    const res = await signOut("token-alice");

    expect(await res.json()).toEqual({
      revoked: false,
      reason: "failed",
      status: "pending",
    });
  });

  it("answers a retryable refusal on routes that rely on a stale list, and still 401 for a known revoked session", async () => {
    serveAs(await bootedReplica());
    await signOut("token-alice");

    vi.setSystemTime(Date.now() + REVOKED_SESSION_MAX_STALENESS_MS + 1);

    await expectRetryable503(await mintKey("token-bob"));
    await expectRetryableV1(await agentOps("token-bob"));
    expect((await me("token-bob")).status).toBe(200);
    await expectRevokedEverywhere("token-alice");
  });

  it("refuses a verified token that names no session on routes that rely on the list alone", async () => {
    serveAs(await bootedReplica());

    for (const res of [
      await mintKey("token-carol"),
      await agentOps("token-carol"),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "UNAUTHORIZED" });
    }
    // A route that forwards the bearer leaves the decision to Convex.
    expect((await me("token-carol")).status).toBe(200);
  });

  it("keeps sign-out idempotent for a session this replica already refuses", async () => {
    serveAs(await bootedReplica());
    await signOut("token-alice");

    const again = await signOut("token-alice");

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ revoked: true });
  });
});
