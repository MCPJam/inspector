/**
 * The mock route over HTTP: who gets in, what each refusal says, and the
 * counters. The bearer middleware is replaced by a table of tokens; the
 * backend by a fetch that answers `/web/mock/resolve` as it would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { MCPClientManager } from "@mcpjam/sdk";

const { stubState } = vi.hoisted(() => ({ stubState: { open: undefined as unknown } }));

vi.mock("../../../middleware/bearer-auth.js", () => {
  const table: Record<string, Record<string, string>> = {
    sk_ann: { authMethod: "workos_api_key", workosUserId: "ann", workosApiKeyId: "k1" },
    sk_other: { authMethod: "workos_api_key", workosUserId: "zed", workosApiKeyId: "k2" },
    jwt_ann: { authMethod: "authkit_jwt", workosUserId: "ann" },
    guest_1: { authMethod: "guest", guestId: "g1" },
    slack_bot: { authMethod: "slack_service", workosUserId: "bot" },
  };
  return {
    bearerAuthMiddleware: async (c: any, next: any) => {
      const token = (c.req.header("authorization") ?? "").slice(7);
      const entry = table[token];
      if (!entry) {
        return c.json({ code: "UNAUTHORIZED", message: "Invalid API key" }, 401);
      }
      for (const [k, v] of Object.entries(entry)) c.set(k, v);
      return next();
    },
  };
});
vi.mock("../auth.js", () => ({
  buildConvexAuthHeaders: (_c: unknown, bearer: string) => ({ Authorization: `Bearer ${bearer}` }),
  callerContextFromHono: (c: any) => ({
    authMethod: c.get("authMethod"),
    workosUserId: c.get("workosUserId"),
  }),
  createAuthorizedManager: vi.fn(async (caller: any, bearer: string, _p: string, ids: string[]) => {
    const opened = await (stubState.open as any)({
      caller,
      bearerToken: bearer,
      resolved: { baseServerId: ids[0] },
    });
    return {
      manager: opened.manager,
      authorizedServerConfigs: { [ids[0]]: opened.config },
      authorizedServerIdentities: { [ids[0]]: opened.identity },
    };
  }),
}));
vi.mock("../../../services/xaa-mint.js", () => ({ resolveXaaIssuer: () => "https://issuer.test" }));

import mockMcp, {
  mockCallerGate,
  mockDoorMiddleware,
  resetMockDoorForTests,
} from "../mock-mcp.js";
import { resetMockBackendCachesForTests } from "../../../services/mock/backend.js";
import { originValidationMiddleware } from "../../../middleware/origin-validation.js";
import { mockConnectionPool } from "../../../services/mock/connection.js";
import { stubRealServer, type StubReal } from "../../../services/mock/__tests__/helpers.js";

const app = new Hono();
app.use("/api/web/mock-mcp/*", ...mockDoorMiddleware);
app.route("/api/web/mock-mcp", mockMcp);

const answer = {
  mockId: "mock1",
  projectId: "proj1",
  name: "Echo mock",
  version: 2,
  headVersion: 2,
  contentHash: "a".repeat(64),
  definition: { tools: { echo: { description: "MOCKED echo" } } },
  baseServerId: "real1",
};
let resolveCalls: Array<{ bearer: string; body: unknown }>;
let stub: StubReal;

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://backend.test";
  resetMockDoorForTests();
  resetMockBackendCachesForTests();
  stub = stubRealServer();
  stubState.open = stub.open;
  resolveCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const bearer = String((init.headers as Record<string, string>).Authorization).slice(7);
      resolveCalls.push({ bearer, body: JSON.parse(String(init.body)) });
      if (bearer === "sk_other") {
        return new Response(JSON.stringify({ code: "MOCK_FORBIDDEN", message: "not a member" }), {
          status: 403,
        });
      }
      return new Response(JSON.stringify(answer), { status: 200 });
    }),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await mockConnectionPool.clear();
});

const rpc = (token: string | undefined, headers: Record<string, string> = {}) =>
  app.request("/api/web/mock-mcp/mock1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

async function refusal(response: Response) {
  const body = (await response.json()) as {
    jsonrpc: string;
    error: { message: string; data: { mockCode: string } };
  };
  expect(body.jsonrpc).toBe("2.0");
  return body.error;
}

describe("a client outside MCPJam", () => {
  it.each(["sk_ann", "jwt_ann"])("lists the edited tools with %s as the bearer", async (token) => {
    const client = new MCPClientManager();
    await client.connectToServer("mock", {
      url: "http://inspector.test/api/web/mock-mcp/mock1",
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      baseFetch: (input, init) => app.fetch(new Request(input as string, init)),
    });
    const tools = await client.listTools("mock");
    expect(tools.tools.find((t) => t.name === "echo")?.description).toBe("MOCKED echo");
    await client.disconnectAllServers();
    // The backend was asked as that caller, by mock id, at the head.
    expect(resolveCalls.every((c) => c.bearer === token)).toBe(true);
    expect(resolveCalls[0].body).toEqual({ mockId: "mock1" });
  });

  it("is refused with no key, and the backend is never asked", async () => {
    const error = await refusal(await rpc(undefined));
    expect(error.data.mockCode).toBe("mock_unauthorized");
    expect(resolveCalls).toHaveLength(0);
  });

  it("is refused with a key the bearer middleware does not know", async () => {
    const response = await rpc("sk_nope");
    expect(response.status).toBe(401);
    expect((await refusal(response)).data.mockCode).toBe("mock_unauthorized");
  });

  it("is refused with a key for a project that does not hold the mock", async () => {
    const response = await rpc("sk_other");
    expect(response.status).toBe(403);
    const error = await refusal(response);
    expect(error.data.mockCode).toBe("mock_forbidden");
    expect(JSON.stringify(error)).not.toMatch(/real1|proj1|backend\.test/);
  });

  it("opens nothing with a grant as the bearer, and does not ask the backend", async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const grant = `${b64({ alg: "HS256" })}.${b64({ purpose: "mock-grant", mockId: "mock1" })}.sig`;
    const response = await rpc(grant);
    expect(response.status).toBe(401);
    expect((await refusal(response)).data.mockCode).toBe("mock_grant_not_accepted");
    expect(resolveCalls).toHaveLength(0);
    expect(stub.opens).toBe(0);
  });

  it("is refused as a guest, by name", async () => {
    const response = await rpc("guest_1");
    expect(response.status).toBe(403);
    expect((await refusal(response)).data.mockCode).toBe("mock_guest_refused");
    expect(resolveCalls).toHaveLength(0);
  });

  it("is refused when the credential is a service's rather than a person's", async () => {
    const response = await rpc("slack_bot");
    expect(response.status).toBe(403);
    expect(resolveCalls).toHaveLength(0);
  });

  it("is not told anything by a bearer the middleware turned away more than once in 30 seconds", async () => {
    await rpc("sk_nope");
    await rpc("sk_nope");
    const third = await rpc("sk_nope");
    expect(third.status).toBe(401);
    expect(resolveCalls).toHaveLength(0);
  });
});

describe("the counters", () => {
  it("allow 60 requests a minute from one address, then answer 429 in JSON-RPC", async () => {
    // No address can be vouched for here, so these share the pooled window (four times 60).
    let last: Response | undefined;
    let refusedAt = -1;
    for (let i = 0; i < 245; i += 1) {
      last = await rpc("sk_nope");
      if (last.status === 429 && refusedAt < 0) refusedAt = i;
    }
    expect(refusedAt).toBe(240);
    const error = await refusal(last as Response);
    expect(error.data.mockCode).toBe("mock_rate_limited");
    expect(last?.headers.get("retry-after")).toBeTruthy();
  });

  it("stops one key at 600 a minute and leaves another key alone", async () => {
    const keyed = new Hono();
    keyed.use("*", async (c, next) => {
      c.set("authMethod", "workos_api_key");
      c.set("workosApiKeyId", c.req.header("x-key") ?? "");
      return next();
    });
    keyed.use("*", mockCallerGate);
    keyed.get("/", (c) => c.text("ok"));
    const call = (key: string) => keyed.request("/", { headers: { "x-key": key } });
    const statuses: number[] = [];
    for (let i = 0; i < 601; i += 1) statuses.push((await call("k1")).status);
    expect(statuses.slice(0, 600).every((status) => status === 200)).toBe(true);
    expect(statuses[600]).toBe(429);
    expect((await call("k2")).status).toBe(200);
  });
});

describe("host and origin", () => {
  it("are checked by the app's middleware in front of the route, before any key is looked at", async () => {
    const guarded = new Hono();
    guarded.use("*", originValidationMiddleware);
    guarded.use("/api/web/mock-mcp/*", ...mockDoorMiddleware);
    guarded.route("/api/web/mock-mcp", mockMcp);
    const response = await guarded.request("/api/web/mock-mcp/mock1", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        authorization: "Bearer sk_ann",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(resolveCalls).toHaveLength(0);
  });
});
