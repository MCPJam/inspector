import { Hono } from "hono";
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
 * MJ-012: the per-server request budget on the `/api/v1` server operations —
 * `.../servers/:serverId/tools`, `/tools/call`, `/resources`,
 * `/resources/read`, `/prompts` and `/prompts/get` — through the REAL `/api/v1`
 * router, because the mount is what a regression would remove.
 *
 * Only the connection step behind the route is stubbed: it validates the
 * synthesized body exactly as the real one does, records which server it
 * would have dialled, and answers without dialling anything. Only `Date` is
 * faked, so the counts are exact.
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

vi.mock("../../web/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../web/auth.js")>();
  return {
    ...actual,
    runEphemeralConnection: async (
      _c: unknown,
      rawBody: unknown,
      schema: z.ZodTypeAny,
    ) => {
      const body = actual.parseWithSchema(schema, rawBody) as {
        serverId: string;
      };
      dialled.push(body.serverId);
      return { tools: [], resources: [], prompts: [], content: [] };
    },
  };
});

const ORIGINAL_HOSTED_MODE = process.env.VITE_MCPJAM_HOSTED_MODE;

/**
 * `HOSTED_MODE` is read when each limiter module is first imported, and the
 * limiters no-op outside hosted mode, so the router is imported into a fresh
 * module registry with it set.
 */
async function loadApp() {
  process.env.VITE_MCPJAM_HOSTED_MODE = "true";
  vi.resetModules();

  const [v1Routes, operationLimit, passthrough] = await Promise.all([
    import("../index"),
    import("../../../middleware/mcp-operation-rate-limit"),
    import("../../../middleware/passthrough-rate-limit"),
  ]);

  const app = new Hono();
  app.route("/api/v1", v1Routes.default);

  return {
    app,
    burst: operationLimit.MCP_OPERATION_BURST,
    callBurst: operationLimit.MCP_OPERATION_CALL_BURST,
    refillMs: operationLimit.MCP_OPERATION_REFILL_INTERVAL_MS,
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
  serverId: string,
  op = "tools",
  bearer = session("user_a"),
  body: Record<string, unknown> = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/v1/projects/project-1/servers/${serverId}/${op}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "203.0.113.40",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

const OPERATION_BODIES: Record<string, Record<string, unknown>> = {
  tools: {},
  "tools/call": { toolName: "echo", parameters: {} },
  resources: {},
  "resources/read": { uri: "file:///a" },
  prompts: {},
  "prompts/get": { promptName: "p" },
};

// The first import of the whole `/api/v1` router is a cold transform of every
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
  validateGuestTokenDetailedAsyncMock.mockResolvedValue({
    valid: false,
    reason: "not_guest",
  });
  classifyAuthKitBearerMock.mockImplementation(async (token: string) =>
    token.startsWith("authkit:")
      ? { kind: "verified", sub: token.slice("authkit:".length).split("/")[0] }
      : { kind: "not_authkit" },
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("MJ-012 — /api/v1 server operations carry a per-server budget", () => {
  it("refuses 40 rapid tool listings for one server once its burst is spent", async () => {
    const { app, burst } = loaded;

    const responses: Response[] = [];
    for (let i = 0; i < 40; i++) responses.push(await call(app, "srv-1"));

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

  it.each(Object.keys(OPERATION_BODIES))(
    "meters POST .../servers/:serverId/%s",
    async (op) => {
      const { app, burst, callBurst } = loaded;
      const limit = op === "tools/call" ? callBurst : burst;
      const codes: number[] = [];
      for (let i = 0; i < limit + 1; i++) {
        codes.push(
          (
            await call(
              app,
              "srv-1",
              op,
              session("user_a"),
              OPERATION_BODIES[op],
            )
          ).status,
        );
      }
      expect(codes).toEqual([...Array(limit).fill(200), 429]);
      expect(dialled).toHaveLength(limit);
    },
  );

  it("admits one call each to 20 different servers", async () => {
    const { app } = loaded;
    for (let i = 0; i < 20; i++) {
      expect((await call(app, `srv-${i}`)).status).toBe(200);
    }
    expect(dialled).toHaveLength(20);
  });

  it("keys on the verified account, not the token", async () => {
    const { app, burst } = loaded;
    for (let i = 0; i < burst; i++) await call(app, "srv-1");
    expect((await call(app, "srv-1")).status).toBe(429);
    expect(
      (await call(app, "srv-1", "tools", session("user_a", "tab-2"))).status,
    ).toBe(429);
    expect((await call(app, "srv-1", "tools", session("user_b"))).status).toBe(
      200,
    );
  });

  it("keys on the path, whatever server the body names", async () => {
    const { app, burst } = loaded;
    for (let i = 0; i < burst; i++) {
      await call(app, "srv-1", "tools", session("user_a"), {
        serverId: `other-${i}`,
      });
    }
    expect((await call(app, "srv-1")).status).toBe(429);
    expect(new Set(dialled)).toEqual(new Set(["srv-1"]));
  });

  it("returns a request to the bucket every refill interval", async () => {
    const { app, burst, refillMs } = loaded;
    for (let i = 0; i < burst; i++) await call(app, "srv-1");
    expect((await call(app, "srv-1")).status).toBe(429);

    vi.setSystemTime(Date.now() + refillMs);
    expect((await call(app, "srv-1")).status).toBe(200);
    expect((await call(app, "srv-1")).status).toBe(429);
  });
});
