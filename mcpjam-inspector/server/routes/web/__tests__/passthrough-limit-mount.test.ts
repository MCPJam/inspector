import { Hono } from "hono";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * MJ-012. `/api/web/*` metered every credential class except the one nobody
 * verifies: `guestRateLimitMiddleware` returns early when there is no
 * `guestId`, and a signed-in AuthKit JWT has none, so a signed-in caller
 * reached these handlers with no budget attached. `/api/v1/*` has metered the
 * same class since it was mounted.
 *
 * These cases go through the REAL `/api/web` router rather than a hand-mounted
 * chain, for the reason `audio-auth.test.ts` gives for MJ-002: the MOUNT is
 * what regressed, and a suite that assembles its own middleware would keep
 * passing after someone removed it.
 */

const validateGuestTokenDetailedAsyncMock = vi.hoisted(() => vi.fn());

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenDetailedAsyncMock,
}));

const ORIGINAL_HOSTED_MODE = process.env.VITE_MCPJAM_HOSTED_MODE;

/**
 * `HOSTED_MODE` is read when the limiter module is first imported, and the
 * limiter no-ops outside hosted mode, so a fresh module registry is the only
 * way to exercise it.
 */
async function loadApp() {
  process.env.VITE_MCPJAM_HOSTED_MODE = "true";
  vi.resetModules();

  const [webRoutes, requestLogContext, passthrough] = await Promise.all([
    import("../index"),
    import("../../../middleware/request-log-context"),
    import("../../../middleware/passthrough-rate-limit"),
  ]);

  const app = new Hono();
  app.use("/api/*", requestLogContext.requestLogContextMiddleware);
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = {};
    await next();
  });
  app.route("/api/web", webRoutes.default);

  return {
    app,
    limit: passthrough.PASSTHROUGH_TOKEN_LIMIT,
    reset: passthrough.resetPassthroughRateLimitForTests,
  };
}

const callProbe = (app: Hono, path: string, bearer: string, ip: string) =>
  app.request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({}),
  });

/**
 * A path under `/tools/*` — the family the finding's PoC (`/tools/list`) lives
 * in — but one with no handler behind it.
 *
 * Deliberate. The mount under test runs in front of every handler, so driving
 * a real one would spend a network round trip per request and prove nothing
 * extra; 120 of them do not finish inside a test timeout. A missing subpath
 * still matches `web.use("/tools/*", bearerAuthMiddleware, ...)` — which is
 * what sets the `authMethod` label the limiter reads — then the `*` mount,
 * and only then 404s. So the chain under test is the production one, and a
 * 404 here means admitted.
 */
const callToolsFamily = (app: Hono, bearer: string, ip: string) =>
  callProbe(app, "/api/web/tools/__mount_probe", bearer, ip);

// The first import of the whole `/api/web` router is a cold transform of every
// route module, which on a loaded runner can outlast a test's own timeout.
// Paying it here keeps each case's clock on the requests it sends.
beforeAll(async () => {
  await loadApp();
}, 120_000);

beforeEach(() => {
  vi.clearAllMocks();
  // A `guest-*` token is a valid guest JWT; anything else falls through to the
  // unverified-passthrough branch, which is what a real WorkOS session does.
  validateGuestTokenDetailedAsyncMock.mockImplementation(async (token: string) =>
    token.startsWith("guest-")
      ? { valid: true, guestId: token }
      : { valid: false, reason: "not_guest" },
  );
});

afterEach(() => {
  if (ORIGINAL_HOSTED_MODE === undefined) {
    delete process.env.VITE_MCPJAM_HOSTED_MODE;
  } else {
    process.env.VITE_MCPJAM_HOSTED_MODE = ORIGINAL_HOSTED_MODE;
  }
});

describe("MJ-012 — /api/web/* meters the unverified passthrough class", () => {
  it("429s a signed-in burst on the /tools family once the budget is spent", async () => {
    const { app, limit, reset } = await loadApp();
    reset();

    for (let i = 0; i < limit; i++) {
      const res = await callToolsFamily(app, "workos-jwt", "203.0.113.20");
      expect(res.status).not.toBe(429);
    }

    const refused = await callToolsFamily(app, "workos-jwt", "203.0.113.20");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBeTruthy();
  });

  it("admits a passthrough caller that stays inside the budget", async () => {
    const { app, limit, reset } = await loadApp();
    reset();

    // A distinct token and address, so neither bucket carries over from the
    // burst above: staying under the ceiling must not be refused.
    for (let i = 0; i < limit - 1; i++) {
      const res = await callToolsFamily(app, "other-jwt", "203.0.113.21");
      expect(res.status).not.toBe(429);
    }
  });

  // `/export` had no bearer middleware at all, so nothing set the label the
  // limiter reads and every call went through unmetered.
  it("429s a signed-in burst on /export", async () => {
    const { app, limit, reset } = await loadApp();
    reset();

    const path = "/api/web/export/__mount_probe";
    for (let i = 0; i < limit; i++) {
      const res = await callProbe(app, path, "workos-jwt", "203.0.113.24");
      expect(res.status).not.toBe(429);
    }

    const refused = await callProbe(app, path, "workos-jwt", "203.0.113.24");
    expect(refused.status).toBe(429);
  });

  // These sub-routers run their own `bearerAuthMiddleware`, so the label is
  // set after the `/api/web` `*` limiter has already passed and each one has
  // to mount the limiter itself.
  it.each([
    ["/api-keys", "/api/web/api-keys/__mount_probe", "203.0.113.22"],
    ["/oauth", "/api/web/oauth/__mount_probe", "203.0.113.23"],
  ])(
    "429s a signed-in burst on %s, which authenticates inside its own router",
    async (_family, path, ip) => {
      const { app, limit, reset } = await loadApp();
      reset();

      for (let i = 0; i < limit; i++) {
        const res = await callProbe(app, path, "workos-jwt", ip);
        expect(res.status).not.toBe(429);
      }

      const refused = await callProbe(app, path, "workos-jwt", ip);
      expect(refused.status).toBe(429);
    },
  );
});
