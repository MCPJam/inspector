import { Hono } from "hono";
import type { Context } from "hono";
import type { z } from "zod";
import { SERVER_REQUEST_BUDGET_REASON } from "../../../../shared/server-request-budget.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * MJ-012: the per-server request budget on `/tools/*`, `/resources/*`,
 * `/prompts/*` and `/tasks/*`, through the REAL `/api/web` router — the mount is
 * what a regression would remove, so these cases do not assemble their own
 * chain (the reasoning `passthrough-limit-mount.test.ts` gives).
 *
 * Only the connection step behind the route is stubbed: it reads and validates
 * the body exactly as the real one does, records which server it would have
 * dialled, and answers without dialling anything. Only `Date` is faked, so the
 * counts are exact.
 */

const validateGuestTokenDetailedAsyncMock = vi.hoisted(() => vi.fn());
const classifyAuthKitBearerMock = vi.hoisted(() => vi.fn());
const dialled = vi.hoisted(() => [] as string[]);

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenDetailedAsyncMock,
}));

vi.mock("../../../services/authkit-jwt.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../services/authkit-jwt.js")
  >()),
  classifyAuthKitBearer: classifyAuthKitBearerMock,
}));

vi.mock("../auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth.js")>();
  return {
    ...actual,
    withEphemeralConnection: async (c: Context, schema: z.ZodTypeAny) => {
      const body = actual.parseWithSchema(
        schema,
        await actual.readJsonBody(c),
      ) as { serverId: string };
      dialled.push(body.serverId);
      return c.json({ ok: true });
    },
  };
});

const ORIGINAL_HOSTED_MODE = process.env.VITE_MCPJAM_HOSTED_MODE;

/**
 * `HOSTED_MODE` is read when each limiter module is first imported, and both
 * limiters no-op outside hosted mode, so the router is imported into a fresh
 * module registry with it set. The limiter modules come from the same import,
 * so their reset seams clear the very buckets the router uses.
 */
async function loadApp() {
  process.env.VITE_MCPJAM_HOSTED_MODE = "true";
  vi.resetModules();

  const [
    webRoutes,
    requestLogContext,
    webBodyLimit,
    operationLimit,
    passthrough,
  ] = await Promise.all([
    import("../index"),
    import("../../../middleware/request-log-context"),
    import("../../../middleware/web-body-limit"),
    import("../../../middleware/mcp-operation-rate-limit"),
    import("../../../middleware/passthrough-rate-limit"),
  ]);

  // Production order: request log context, the body limit, then the router.
  const app = new Hono();
  app.use("/api/*", requestLogContext.requestLogContextMiddleware);
  app.use("/api/web/*", webBodyLimit.webBodyLimit());
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = {};
    await next();
  });
  app.route("/api/web", webRoutes.default);

  return {
    app,
    burst: operationLimit.MCP_OPERATION_BURST,
    refillMs: operationLimit.MCP_OPERATION_REFILL_INTERVAL_MS,
    tokenLimit: passthrough.PASSTHROUGH_TOKEN_LIMIT,
    reset: () => {
      operationLimit.resetMcpOperationRateLimitForTests();
      passthrough.resetPassthroughRateLimitForTests();
    },
  };
}

let loaded: Awaited<ReturnType<typeof loadApp>>;

/**
 * A verified AuthKit session for `userId`. The classifier mock reads the user
 * from everything before `/`, so `session("user_a", "tab-2")` is a second,
 * different token for the same account.
 */
const session = (userId: string, tab?: string) =>
  `authkit:${userId}${tab ? `/${tab}` : ""}`;

function call(
  app: Hono,
  path: string,
  serverId: string,
  bearer = session("user_a"),
  ip = "203.0.113.30",
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": ip,
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ projectId: "project-1", serverId }),
    }),
  );
}

// The first import of the whole `/api/web` router is a cold transform of every
// route module, which on a loaded runner can outlast a test's own timeout.
beforeAll(async () => {
  loaded = await loadApp();
}, 120_000);

afterAll(() => {
  if (ORIGINAL_HOSTED_MODE === undefined) {
    delete process.env.VITE_MCPJAM_HOSTED_MODE;
  } else {
    process.env.VITE_MCPJAM_HOSTED_MODE = ORIGINAL_HOSTED_MODE;
  }
});

beforeEach(() => {
  loaded.reset();
  vi.clearAllMocks();
  dialled.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  validateGuestTokenDetailedAsyncMock.mockImplementation(
    async (token: string) =>
      token.startsWith("guest-")
        ? { valid: true, guestId: token }
        : { valid: false, reason: "not_guest" },
  );
  classifyAuthKitBearerMock.mockImplementation(async (token: string) =>
    token.startsWith("authkit:")
      ? { kind: "verified", sub: token.slice("authkit:".length).split("/")[0] }
      : { kind: "not_authkit" },
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MJ-012 — /api/web MCP operation routes carry a per-server budget", () => {
  it("refuses 40 rapid tools/list calls to one server once its burst is spent", async () => {
    const { app, burst } = loaded;

    const responses: Response[] = [];
    for (let i = 0; i < 40; i++) {
      responses.push(await call(app, "/api/web/tools/list", "srv-1"));
    }

    const refused = responses.filter((res) => res.status === 429);
    expect(refused.length).toBeGreaterThan(0);
    // The clock does not move, so nothing refills: exactly the burst gets in.
    expect(responses.filter((res) => res.status === 200)).toHaveLength(burst);
    expect(dialled).toHaveLength(burst);
    for (const res of refused) {
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
      expect(await res.json()).toEqual({
        code: "RATE_LIMITED",
        message: expect.any(String),
        details: { reason: SERVER_REQUEST_BUDGET_REASON },
      });
    }
  });

  it("admits one call each to 20 different servers", async () => {
    const { app } = loaded;

    for (let i = 0; i < 20; i++) {
      const res = await call(app, "/api/web/tools/list", `srv-${i}`);
      expect(res.status).toBe(200);
    }
    expect(dialled).toHaveLength(20);
  });

  it("keeps a separate budget per principal", async () => {
    const { app, burst } = loaded;
    for (let i = 0; i < burst; i++) {
      await call(app, "/api/web/tools/list", "srv-1", session("user_a"));
    }
    expect(
      (await call(app, "/api/web/tools/list", "srv-1", session("user_a")))
        .status,
    ).toBe(429);
    // Keyed on the account `bearerAuthMiddleware` verified, not on the token.
    expect(
      (
        await call(
          app,
          "/api/web/tools/list",
          "srv-1",
          session("user_a", "tab-2"),
        )
      ).status,
    ).toBe(429);

    for (const bearer of [
      session("user_b"),
      "guest-token-a",
      "opaque-session-token",
    ]) {
      const res = await call(app, "/api/web/tools/list", "srv-1", bearer);
      expect(res.status).toBe(200);
    }
  });

  it("keeps a separate budget per route family", async () => {
    const { app, burst } = loaded;
    for (let i = 0; i < burst; i++) {
      await call(app, "/api/web/tools/list", "srv-1");
    }
    expect((await call(app, "/api/web/tools/list", "srv-1")).status).toBe(429);

    for (const path of [
      "/api/web/resources/list",
      "/api/web/prompts/list",
      "/api/web/tasks/list",
    ]) {
      const res = await call(app, path, "srv-1");
      expect(res.status).toBe(200);
    }
  });

  it("returns a request to the bucket every refill interval", async () => {
    const { app, burst, refillMs } = loaded;
    for (let i = 0; i < burst; i++) {
      await call(app, "/api/web/tools/list", "srv-1");
    }
    expect((await call(app, "/api/web/tools/list", "srv-1")).status).toBe(429);

    vi.setSystemTime(Date.now() + refillMs);
    expect((await call(app, "/api/web/tools/list", "srv-1")).status).toBe(200);
    expect((await call(app, "/api/web/tools/list", "srv-1")).status).toBe(429);
  });

  it("still applies the per-token limit when every call names a new server", async () => {
    const { app, tokenLimit } = loaded;

    for (let i = 0; i < tokenLimit; i++) {
      const res = await call(app, "/api/web/tools/list", `srv-${i}`);
      expect(res.status).toBe(200);
    }

    const refused = await call(app, "/api/web/tools/list", "srv-unused");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBeTruthy();
    expect(dialled).toHaveLength(tokenLimit);
  });
});
