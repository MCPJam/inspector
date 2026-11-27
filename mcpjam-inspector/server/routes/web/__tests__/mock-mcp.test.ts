/**
 * The mock route over HTTP: who gets in and what each refusal says. The bearer
 * middleware is replaced by a table of tokens; the backend by a fetch that
 * answers `/web/mock/resolve` as it would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { MCPClientManager } from "@mcpjam/sdk";

vi.mock("../../../middleware/bearer-auth.js", () => {
  const table: Record<string, Record<string, string>> = {
    sk_ann: { authMethod: "workos_api_key", workosUserId: "ann" },
    sk_other: { authMethod: "workos_api_key", workosUserId: "zed" },
    jwt_ann: { authMethod: "authkit_jwt", workosUserId: "ann" },
    guest_1: { authMethod: "guest" },
    slack_bot: { authMethod: "slack_service", workosUserId: "bot" },
  };
  return {
    bearerAuthMiddleware: async (c: any, next: any) => {
      const token = (c.req.header("authorization") ?? "").slice(7);
      const entry = table[token];
      if (!entry) return c.json({ code: "UNAUTHORIZED", message: "Invalid API key" }, 401);
      for (const [k, v] of Object.entries(entry)) c.set(k, v);
      return next();
    },
  };
});
vi.mock("../../../services/xaa-mint.js", () => ({ resolveXaaIssuer: () => "https://issuer.test" }));
vi.mock("../auth.js", () => ({
  buildConvexAuthHeaders: (_c: unknown, bearer: string) => ({ Authorization: `Bearer ${bearer}` }),
  callerContextFromHono: (c: any) => ({
    authMethod: c.get("authMethod"),
    workosUserId: c.get("workosUserId"),
  }),
}));

import mockMcp, { mockDoorMiddleware } from "../mock-mcp.js";

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
  definition: { tools: { echo: { description: "MOCKED echo", answer: { from: "saved", cases: [{ result: { content: [{ type: "text", text: "hi" }] } }] } } } },
  baseServerId: null,
};
let resolveCalls: Array<{ bearer: string; body: unknown }>;
let revoked: Set<string>;

beforeEach(() => {
  process.env.CONVEX_HTTP_URL = "https://backend.test";
  resolveCalls = [];
  revoked = new Set(["sk_other"]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const bearer = String((init.headers as Record<string, string>).Authorization).slice(7);
      resolveCalls.push({ bearer, body: JSON.parse(String(init.body)) });
      if (revoked.has(bearer)) {
        return new Response(JSON.stringify({ code: "MOCK_FORBIDDEN", message: "not a member" }), { status: 403 });
      }
      return new Response(JSON.stringify(answer), { status: 200 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const rpc = (token: string | undefined) =>
  app.request("/api/web/mock-mcp/mock1", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
  it.each(["sk_ann", "jwt_ann"])("lists and calls the mock's tools with %s as the bearer", async (token) => {
    const client = new MCPClientManager();
    await client.connectToServer("mock", {
      url: "http://inspector.test/api/web/mock-mcp/mock1",
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      baseFetch: ((input: string, init?: RequestInit) => app.fetch(new Request(input, init))) as typeof fetch,
    });
    const tools = await client.listTools("mock");
    expect(tools.tools.find((t) => t.name === "echo")?.description).toBe("MOCKED echo");
    await client.executeTool("mock", "echo", {});
    await client.disconnectAllServers();
    expect(resolveCalls.length).toBeGreaterThan(1);
    expect(resolveCalls.every((c) => c.bearer === token)).toBe(true);
    expect(resolveCalls[0].body).toEqual({ mockId: "mock1" });
  });

  it("is refused with no key, and the backend is never asked", async () => {
    const error = await refusal(await rpc(undefined));
    expect(error.data.mockCode).toBe("mock_unauthorized");
    expect(resolveCalls).toHaveLength(0);
  });

  it("is refused, in JSON-RPC, with a key the bearer middleware does not know", async () => {
    const response = await rpc("sk_nope");
    expect(response.status).toBe(401);
    expect((await refusal(response)).data.mockCode).toBe("mock_unauthorized");
    expect(resolveCalls).toHaveLength(0);
  });

  it("is refused with a key for a project that does not hold the mock, naming nothing", async () => {
    const response = await rpc("sk_other");
    expect(response.status).toBe(403);
    const error = await refusal(response);
    expect(error.data.mockCode).toBe("mock_forbidden");
    expect(JSON.stringify(error)).not.toMatch(/proj1|backend\.test/);
  });

  it("tells an API key that its project does not hold the mock", async () => {
    const error = await refusal(await rpc("sk_other"));
    expect(error.message).toBe(
      "This API key's project does not hold this mock server. Use a key for the project that holds it.",
    );
  });

  it("tells a signed-in caller to ask the project's owner, not to use a key", async () => {
    revoked.add("jwt_ann");
    const error = await refusal(await rpc("jwt_ann"));
    expect(error.data.mockCode).toBe("mock_forbidden");
    expect(error.message).toBe(
      "You do not have access to this mock server's project. Ask the project's owner to add you, then try again.",
    );
    expect(error.message).not.toMatch(/key/i);
  });

  it("is refused on the next request once the backend revokes it", async () => {
    expect((await rpc("sk_ann")).status).toBe(200);
    revoked.add("sk_ann");
    expect((await rpc("sk_ann")).status).toBe(403);
  });

  it("opens nothing with a grant as the bearer, and does not ask the backend", async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const grant = `${b64({ alg: "HS256" })}.${b64({ purpose: "mock-grant", mockId: "mock1" })}.sig`;
    const response = await rpc(grant);
    expect(response.status).toBe(401);
    expect((await refusal(response)).data.mockCode).toBe("mock_grant_not_accepted");
    expect(resolveCalls).toHaveLength(0);
  });

  it("is refused as a guest, by name", async () => {
    const response = await rpc("guest_1");
    expect(response.status).toBe(403);
    expect((await refusal(response)).data.mockCode).toBe("mock_guest_refused");
    expect(resolveCalls).toHaveLength(0);
  });

  it("is refused when the credential is a service's rather than a person's", async () => {
    expect((await rpc("slack_bot")).status).toBe(403);
    expect(resolveCalls).toHaveLength(0);
  });
});
