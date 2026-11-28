/**
 * The mock door's limits over HTTP: one source address and one key on one mock
 * are each held to their line before the backend is asked anything. The backend
 * is a counted fetch, so a limited request is proven to have cost none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("../../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config.js")>()),
  HOSTED_MODE: true,
}));
// Any `sk_<name>` is a signed-in key; the principal is the key itself.
vi.mock("../../../middleware/bearer-auth.js", () => ({
  bearerAuthMiddleware: async (c: any, next: any) => {
    const token = (c.req.header("authorization") ?? "").slice(7);
    if (!token.startsWith("sk_")) return c.json({ code: "UNAUTHORIZED", message: "Invalid API key" }, 401);
    c.set("authMethod", "workos_api_key");
    c.set("workosApiKeyId", token);
    c.set("workosUserId", token);
    return next();
  },
}));
vi.mock("../../../services/xaa-mint.js", () => ({ resolveXaaIssuer: () => "https://issuer.test" }));
vi.mock("../auth.js", () => ({
  buildConvexAuthHeaders: (_c: unknown, bearer: string) => ({ Authorization: `Bearer ${bearer}` }),
  callerContextFromHono: (c: any) => ({ authMethod: c.get("authMethod"), workosUserId: c.get("workosUserId") }),
}));

import { resetMcpOperationRateLimitForTests, MCP_OPERATION_BURST } from "../../../middleware/mcp-operation-rate-limit.js";
import { MOCK_DOOR_SOURCE_LIMIT, resetMockDoorSourceLimitForTests } from "../../../middleware/mock-door-source-limit.js";
import mockMcp, { mockDoorMiddleware } from "../mock-mcp.js";

const app = new Hono();
app.use("/api/web/mock-mcp/*", ...mockDoorMiddleware);
app.route("/api/web/mock-mcp", mockMcp);

const answer = {
  mockId: "mock1",
  projectId: "proj1",
  name: "Echo mock",
  version: 1,
  headVersion: 1,
  contentHash: "a".repeat(64),
  definition: { tools: { echo: { description: "MOCKED echo", answer: { from: "saved", cases: [{ result: { content: [] } }] } } } },
  baseServerId: null,
};
let backendCalls: number;

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://backend.test";
  backendCalls = 0;
  resetMcpOperationRateLimitForTests();
  resetMockDoorSourceLimitForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      backendCalls += 1;
      return new Response(JSON.stringify(answer), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const rpc = (token: string, { mock = "mock1", address = "203.0.113.7" } = {}) =>
  app.request(`/api/web/mock-mcp/${mock}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "cf-connecting-ip": address,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

async function mockCode(response: Response) {
  const body = (await response.json()) as { jsonrpc: string; error: { message: string; data: { mockCode: string } } };
  expect(body.jsonrpc).toBe("2.0");
  return body.error;
}

describe("the per-key limit", () => {
  it("refuses a key's burst on one mock before the backend is asked, and says when to retry", async () => {
    for (let i = 0; i < MCP_OPERATION_BURST; i += 1) expect((await rpc("sk_ann")).status).toBe(200);
    expect(backendCalls).toBe(MCP_OPERATION_BURST);

    const limited = await rpc("sk_ann");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    const error = await mockCode(limited);
    expect(error.data.mockCode).toBe("mock_rate_limited");
    expect(error.message).toMatch(/slow down and retry/i);
    expect(backendCalls).toBe(MCP_OPERATION_BURST);
  });

  it("holds one key apart from another key and one mock apart from another", async () => {
    for (let i = 0; i < MCP_OPERATION_BURST; i += 1) await rpc("sk_ann");
    expect((await rpc("sk_ann")).status).toBe(429);
    expect((await rpc("sk_bob")).status).toBe(200);
    expect((await rpc("sk_ann", { mock: "mock2" })).status).toBe(200);
  });
});

describe("a request of any method", () => {
  const get = (token: string) =>
    app.request("/api/web/mock-mcp/mock1", {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
        "cf-connecting-ip": "203.0.113.7",
      },
    });

  it("spends the key's budget on the mock, so a flood of GETs cannot reach the backend", async () => {
    for (let i = 0; i < MCP_OPERATION_BURST; i += 1) {
      await (await get("sk_ann")).body?.cancel();
    }
    expect(backendCalls).toBe(MCP_OPERATION_BURST);

    const limited = await get("sk_ann");
    expect(limited.status).toBe(429);
    expect((await mockCode(limited)).data.mockCode).toBe("mock_rate_limited");
    expect(backendCalls).toBe(MCP_OPERATION_BURST);
    // It is the one budget: a POST from the same key is refused too.
    expect((await rpc("sk_ann")).status).toBe(429);
    expect(backendCalls).toBe(MCP_OPERATION_BURST);
  });
});

describe("the per-source limit", () => {
  it("refuses a source address at its line, before the key is checked or the backend asked", async () => {
    // A new key each time, so only the address can be what refuses.
    for (let i = 0; i < MOCK_DOOR_SOURCE_LIMIT; i += 1) expect((await rpc(`sk_u${i}`)).status).toBe(200);
    expect(backendCalls).toBe(MOCK_DOOR_SOURCE_LIMIT);

    const limited = await rpc("sk_fresh");
    expect(limited.status).toBe(429);
    expect((await mockCode(limited)).data.mockCode).toBe("mock_rate_limited");
    expect(backendCalls).toBe(MOCK_DOOR_SOURCE_LIMIT);

    // Another address is not held back by it.
    expect((await rpc("sk_fresh", { address: "198.51.100.9" })).status).toBe(200);
  }, 30_000);
});
