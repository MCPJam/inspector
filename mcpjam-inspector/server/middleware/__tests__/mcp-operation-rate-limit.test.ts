/**
 * MJ-012: the per-server request budget on the MCP operation routes.
 *
 * One token bucket per (principal, server, route family): a burst of
 * MCP_OPERATION_BURST, then one request back every refill interval. Only
 * `Date` is faked, so every count below is exact: nothing refills unless a
 * test moves the clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ContextVariableMap } from "hono";

vi.mock("../../config.js", () => ({ HOSTED_MODE: true }));

const { SERVER_REQUEST_BUDGET_REASON } =
  await import("../../../shared/server-request-budget.js");

const {
  MCP_OPERATION_BURST: BURST,
  MCP_OPERATION_MAX_ENTRIES: MAX_ENTRIES,
  MCP_OPERATION_REFILL_INTERVAL_MS: REFILL_MS,
  mcpOperationRateLimit,
  mcpOperationRateLimitSizeForTests,
  resetMcpOperationRateLimitForTests,
} = await import("../mcp-operation-rate-limit.js");

const FAMILIES = ["tools", "resources", "prompts", "tasks"] as const;

/** The identity `bearerAuthMiddleware` would have resolved upstream. */
type Identity = {
  authMethod?: ContextVariableMap["authMethod"];
  workosUserId?: string;
  guestId?: string;
  workosApiKeyId?: string;
  bearer?: string;
};

const USER_A: Identity = {
  authMethod: "authkit_jwt",
  workosUserId: "user_a",
  bearer: "session-token-a",
};
const USER_B: Identity = {
  authMethod: "authkit_jwt",
  workosUserId: "user_b",
  bearer: "session-token-b",
};

/**
 * The limiter mounted per family the way `routes/web/index.ts` mounts it,
 * behind a stub that sets the identity. The route answers malformed JSON with
 * a 400 the way `readJsonBody` does, and otherwise echoes the body it read.
 */
function createApp(
  limiter: typeof mcpOperationRateLimit = mcpOperationRateLimit,
) {
  const app = new Hono();
  app.use("/api/web/*", async (c, next) => {
    const identity = JSON.parse(
      c.req.header("x-test-identity") ?? "{}",
    ) as Identity;
    if (identity.authMethod) c.set("authMethod", identity.authMethod);
    if (identity.workosUserId) c.set("workosUserId", identity.workosUserId);
    if (identity.guestId) c.set("guestId", identity.guestId);
    if (identity.workosApiKeyId) {
      c.set("workosApiKeyId", identity.workosApiKeyId);
    }
    await next();
  });
  for (const family of FAMILIES) {
    app.use(`/api/web/${family}/*`, limiter(family));
  }
  app.post("/api/web/:family/:operation", async (c) => {
    try {
      return c.json({ received: await c.req.json() });
    } catch {
      return c.json({ code: "VALIDATION_ERROR" }, 400);
    }
  });
  return app;
}

function post(
  app: Hono,
  path: string,
  body: unknown,
  identity: Identity = USER_A,
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${identity.bearer ?? "session-token"}`,
        "x-test-identity": JSON.stringify(identity),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const toolsList =
  (serverId: string, identity: Identity = USER_A) =>
  (app: Hono) =>
    post(
      app,
      "/api/web/tools/list",
      { projectId: "project-1", serverId },
      identity,
    );

/** Send `count` requests and return their statuses in order. */
async function statuses(
  app: Hono,
  count: number,
  send: (app: Hono) => Promise<Response>,
): Promise<number[]> {
  const result: number[] = [];
  for (let i = 0; i < count; i++) result.push((await send(app)).status);
  return result;
}

const admitted = (codes: number[]) => codes.filter((code) => code !== 429);

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  resetMcpOperationRateLimitForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("one principal, one server", () => {
  it("admits a burst, then answers 429 with Retry-After and the RATE_LIMITED envelope", async () => {
    const app = createApp();
    const responses: Response[] = [];
    for (let i = 0; i < 40; i++) {
      responses.push(await toolsList("srv-1")(app));
    }

    expect(responses.map((res) => res.status)).toEqual([
      ...Array(BURST).fill(200),
      ...Array(40 - BURST).fill(429),
    ]);
    const refused = responses[BURST];
    expect(refused.headers.get("Retry-After")).toBe(String(REFILL_MS / 1000));
    // The marker is what tells the client this refusal is retryable.
    expect(await refused.json()).toEqual({
      code: "RATE_LIMITED",
      message: expect.any(String),
      details: { reason: SERVER_REQUEST_BUDGET_REASON },
    });
  });

  it("returns one request per refill interval, and never more than the burst", async () => {
    const app = createApp();
    await statuses(app, BURST, toolsList("srv-1"));

    const empty = await toolsList("srv-1")(app);
    expect(empty.status).toBe(429);
    expect(empty.headers.get("Retry-After")).toBe("2");

    // Retry-After counts down to the next token, rounded up to a second.
    advance(REFILL_MS - 500);
    const almost = await toolsList("srv-1")(app);
    expect(almost.status).toBe(429);
    expect(almost.headers.get("Retry-After")).toBe("1");

    advance(500);
    expect(await statuses(app, 2, toolsList("srv-1"))).toEqual([200, 429]);

    // A long idle refills to the burst and stops there.
    advance(100 * REFILL_MS);
    expect(
      admitted(await statuses(app, 3 * BURST, toolsList("srv-1"))),
    ).toHaveLength(BURST);
  });

  it("spends nothing on a refused request", async () => {
    const app = createApp();
    await statuses(app, BURST, toolsList("srv-1"));
    expect(admitted(await statuses(app, 50, toolsList("srv-1")))).toHaveLength(
      0,
    );

    advance(REFILL_MS);
    expect(await statuses(app, 2, toolsList("srv-1"))).toEqual([200, 429]);
  });

  it("leaves the body readable by the route behind it", async () => {
    const app = createApp();
    const body = { projectId: "project-1", serverId: "srv-1", cursor: "c-1" };

    const res = await post(app, "/api/web/tools/list", body);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: body });
  });
});

describe("what gets its own bucket", () => {
  it("each server: one call each to 20 servers is never refused", async () => {
    const app = createApp();
    for (let i = 0; i < 20; i++) {
      expect((await toolsList(`srv-${i}`)(app)).status).toBe(200);
    }

    // Spending one server's budget leaves the others whole.
    await statuses(app, BURST, toolsList("srv-busy"));
    expect((await toolsList("srv-busy")(app)).status).toBe(429);
    expect(
      admitted(await statuses(app, BURST, toolsList("srv-quiet"))),
    ).toHaveLength(BURST);
  });

  it("each principal", async () => {
    const app = createApp();
    await statuses(app, BURST, toolsList("srv-1", USER_A));
    expect((await toolsList("srv-1", USER_A)(app)).status).toBe(429);

    const others: Identity[] = [
      USER_B,
      { authMethod: "guest", guestId: "guest_a", bearer: "guest-token-a" },
      // A key is its own principal, separate from the account that owns it.
      {
        authMethod: "workos_api_key",
        workosApiKeyId: "api_key_a",
        workosUserId: "user_a",
        bearer: "sk_test_a",
      },
      // Same id string as USER_A's account, different kind of principal.
      { authMethod: "guest", guestId: "user_a", bearer: "guest-token-b" },
      { authMethod: "unverified_passthrough", bearer: "opaque-token-a" },
    ];
    for (const identity of others) {
      expect(
        admitted(await statuses(app, BURST, toolsList("srv-1", identity))),
      ).toHaveLength(BURST);
    }
  });

  it("a verified session per account, so a second token for it shares the budget", async () => {
    const app = createApp();
    await statuses(app, BURST, toolsList("srv-1", USER_A));

    const secondToken = { ...USER_A, bearer: "session-token-a-refreshed" };
    expect((await toolsList("srv-1", secondToken)(app)).status).toBe(429);
  });

  it("an unverified bearer per token", async () => {
    const app = createApp();
    const first = {
      authMethod: "unverified_passthrough",
      bearer: "opaque-1",
    } as const;
    const second = {
      authMethod: "unverified_passthrough",
      bearer: "opaque-2",
    } as const;
    await statuses(app, BURST, toolsList("srv-1", first));

    expect((await toolsList("srv-1", first)(app)).status).toBe(429);
    expect((await toolsList("srv-1", second)(app)).status).toBe(200);
  });

  it("each route family, shared by the operations inside it", async () => {
    const app = createApp();
    await statuses(app, BURST, toolsList("srv-1"));

    // Same family, same bucket.
    const execute = await post(app, "/api/web/tools/execute", {
      projectId: "project-1",
      serverId: "srv-1",
      toolName: "echo",
    });
    expect(execute.status).toBe(429);

    for (const path of [
      "/api/web/resources/list",
      "/api/web/prompts/get",
      "/api/web/tasks/get-batch",
    ]) {
      const codes: number[] = [];
      for (let i = 0; i < BURST; i++) {
        codes.push(
          (await post(app, path, { projectId: "project-1", serverId: "srv-1" }))
            .status,
        );
      }
      expect(admitted(codes)).toHaveLength(BURST);
    }
  });
});

describe("requests that do not name exactly one server", () => {
  it("share one bucket per principal and family, apart from every named server", async () => {
    const app = createApp();
    const bodies: unknown[] = [
      { projectId: "project-1" },
      { projectId: "project-1", serverId: 42 },
      { projectId: "project-1", serverId: "" },
      { projectId: "project-1", serverId: "x".repeat(300) },
      "not json",
      "[1, 2, 3]",
      "",
      "null",
    ];
    const codes: number[] = [];
    for (let i = 0; i < BURST; i++) {
      const body = bodies[i % bodies.length];
      codes.push((await post(app, "/api/web/tools/list", body)).status);
    }
    // Malformed bodies still reach the route, which answers them itself.
    expect(codes).not.toContain(429);
    expect(codes).toContain(400);

    for (const body of bodies) {
      expect((await post(app, "/api/web/tools/list", body)).status).toBe(429);
    }
    // Named servers and other families keep their own budgets.
    expect((await toolsList("srv-1")(app)).status).toBe(200);
    expect((await post(app, "/api/web/resources/list", {})).status).toBe(200);
    expect((await post(app, "/api/web/tools/list", {}, USER_B)).status).toBe(
      200,
    );
  });

  it("a batch is charged once, however many servers it lists", async () => {
    const app = createApp();
    const listMulti = (a: Hono) =>
      post(a, "/api/web/prompts/list-multi", {
        projectId: "project-1",
        serverIds: Array.from({ length: 50 }, (_, i) => `srv-${i}`),
      });

    expect(admitted(await statuses(app, BURST, listMulti))).toHaveLength(BURST);
    expect(mcpOperationRateLimitSizeForTests()).toBe(1);
    expect((await listMulti(app)).status).toBe(429);

    // A single-server call to a listed server still has its own budget.
    const single = await post(app, "/api/web/prompts/list", {
      projectId: "project-1",
      serverId: "srv-3",
    });
    expect(single.status).toBe(200);
  });

  it("a body naming a server and a batch spends both budgets", async () => {
    const app = createApp();
    await statuses(app, BURST, toolsList("srv-1"));

    const both = await post(app, "/api/web/tools/list", {
      projectId: "project-1",
      serverId: "srv-1",
      serverIds: ["srv-2"],
    });
    expect(both.status).toBe(429);

    // And the other way round: an empty shared bucket refuses it too.
    for (let i = 0; i < BURST; i++) {
      await post(app, "/api/web/prompts/list-multi", {
        projectId: "project-1",
        serverIds: ["srv-9"],
      });
    }
    const named = await post(app, "/api/web/prompts/list-multi", {
      projectId: "project-1",
      serverId: "srv-fresh",
      serverIds: ["srv-9"],
    });
    expect(named.status).toBe(429);
  });
});

describe("scope", () => {
  it("charges POST only", async () => {
    const app = createApp();
    for (let i = 0; i < 3 * BURST; i++) {
      const res = await app.request("/api/web/tools/list", {
        headers: { "x-test-identity": JSON.stringify(USER_A) },
      });
      expect(res.status).not.toBe(429);
    }
    expect(mcpOperationRateLimitSizeForTests()).toBe(0);
    expect(
      admitted(await statuses(app, BURST, toolsList("srv-1"))),
    ).toHaveLength(BURST);
  });
});

describe("bounded table", () => {
  it("at the cap with no full bucket, still charges a newcomer: a burst, then 429", async () => {
    const app = createApp();
    // Filled to the cap with buckets that are all still refilling.
    for (let i = 0; i < MAX_ENTRIES; i++) {
      expect((await toolsList(`srv-${i}`)(app)).status).toBe(200);
    }
    expect(mcpOperationRateLimitSizeForTests()).toBe(MAX_ENTRIES);

    expect(await statuses(app, BURST + 1, toolsList("srv-new"))).toEqual([
      ...Array(BURST).fill(200),
      429,
    ]);
    expect(mcpOperationRateLimitSizeForTests()).toBe(MAX_ENTRIES);
  }, 60_000);

  it("drops the least recently used bucket and keeps a recently used spent one", async () => {
    const app = createApp();
    // The two oldest entries, both spent; `srv-busy` is the older one.
    await statuses(app, BURST, toolsList("srv-busy"));
    await statuses(app, BURST, toolsList("srv-idle"));
    for (let i = 2; i < MAX_ENTRIES; i++) {
      await toolsList(`srv-${i}`)(app);
    }
    // Using `srv-busy` again, even refused, moves it from oldest to newest.
    expect((await toolsList("srv-busy")(app)).status).toBe(429);

    // A newcomer at the cap pushes out the least recently used: `srv-idle`.
    expect((await toolsList("srv-new")(app)).status).toBe(200);
    expect(mcpOperationRateLimitSizeForTests()).toBe(MAX_ENTRIES);
    expect((await toolsList("srv-busy")(app)).status).toBe(429);
    // Dropped, `srv-idle` starts again from a full bucket: the one early
    // refill an eviction can give, and no more than the burst.
    expect(await statuses(app, BURST + 1, toolsList("srv-idle"))).toEqual([
      ...Array(BURST).fill(200),
      429,
    ]);
  }, 60_000);

  it("drops buckets that have refilled before anything still refilling", async () => {
    const app = createApp();
    for (let i = 1; i < MAX_ENTRIES; i++) {
      await toolsList(`srv-${i}`)(app);
    }
    // Those buckets are full again; the one spent now is not.
    advance(REFILL_MS);
    await statuses(app, BURST, toolsList("srv-hot"));
    expect(mcpOperationRateLimitSizeForTests()).toBe(MAX_ENTRIES);

    expect((await toolsList("srv-new")(app)).status).toBe(200);
    expect(mcpOperationRateLimitSizeForTests()).toBe(2);
    expect((await toolsList("srv-hot")(app)).status).toBe(429);
  }, 60_000);
});

describe("outside hosted mode", () => {
  it("meters nothing", async () => {
    vi.resetModules();
    vi.doMock("../../config.js", () => ({ HOSTED_MODE: false }));
    try {
      const local = await import("../mcp-operation-rate-limit.js");
      const app = createApp(local.mcpOperationRateLimit);
      expect(
        admitted(await statuses(app, 3 * BURST, toolsList("srv-1"))),
      ).toHaveLength(3 * BURST);
    } finally {
      vi.doUnmock("../../config.js");
    }
  });
});
