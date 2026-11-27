/**
 * The mock server routes: create, save a version, read one, and the
 * forwarding policy.
 *
 * Convex is mocked at `convex/browser` and the live connection at
 * `runEphemeralConnection`, so these prove the gateway: what it checks before
 * the backend is called, what it forwards, and how each backend refusal is
 * answered. The backend's own rules (tiers, the flag, the caps) are covered in
 * the backend's tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";

const mocks = vi.hoisted(() => ({
  guest: vi.fn(),
  query: vi.fn(),
  mutation: vi.fn(),
  connect: vi.fn(),
}));

// The address comes from the Inspector's configured public URL, never from the
// request; pin it so these tests do not depend on the environment.
vi.mock("../../../services/mock/address.js", () => ({
  mockServerAddress: (mockId: string) => `https://inspector.test/api/web/mock-mcp/${mockId}`,
}));
vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: mocks.guest,
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return { setAuth: vi.fn(), query: mocks.query, mutation: mocks.mutation };
  }),
}));
// The live connection to the real server, as the caller.
vi.mock("../../web/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../web/auth.js")>("../../web/auth.js");
  return {
    ...actual,
    runEphemeralConnection: async (
      _c: unknown,
      rawBody: Record<string, unknown>,
      schema: { parse(value: unknown): { serverId: string } },
      fn: (manager: unknown, body: { serverId: string }, refused: object) => Promise<unknown>,
    ) => {
      const body = schema.parse(rawBody);
      mocks.connect(body);
      const manager = {
        listTools: async () => ({ tools: real.tools }),
        listPrompts: async () => ({ prompts: [{ name: "summarize" }] }),
        listResources: async () => ({ resources: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        getInitializationInfo: () => real.info,
      };
      return fn(manager, body, {});
    },
  };
});

import v1Routes from "../index.js";

const PROJECT = "p1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const BASE = "srvxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const MOCK = "mockxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const MOCKS = `/api/v1/projects/${PROJECT}/mock-servers`;
const POLICY_PATH = `/api/v1/projects/${PROJECT}/mock-forwarding-policy`;

const SEARCH = {
  name: "search",
  description: "Search the index.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
const real: { tools: unknown[]; info: unknown } = { tools: [], info: undefined };

type Handler = (args: Record<string, any>) => unknown;
let queries: Record<string, Handler>;
let mutations: Record<string, Handler>;

const nameOf = (value: unknown) => getFunctionName(value as never);
const calls = (mock: typeof mocks.mutation, name: string) =>
  mock.mock.calls.filter(([fn]) => nameOf(fn) === name).map(([, args]) => args);

function request(method: string, path: string, opts: { body?: unknown } = {}) {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app.request(`https://inspector.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}
async function json(response: Response | Promise<Response>) {
  return (await (await response).json()) as Record<string, any>;
}

const refusal = (code: string, message: string, extra: object = {}) => new ConvexError({ code, message, ...extra });
const stored = (definition: object, over: Record<string, unknown> = {}) => ({
  mockId: MOCK,
  projectId: PROJECT,
  name: "markets (mock)",
  baseServerId: BASE,
  headVersion: 2,
  version: 2,
  contentHash: "hash-2",
  definitionJson: JSON.stringify(definition),
  loosened: [],
  createdAt: 5,
  ...over,
});
const POLICY = { forwarding: "block", scope: "workspace", updatedAt: 9 };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://convex.example.com");
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex-http.example.com");
  mocks.guest.mockResolvedValue({ valid: false });
  real.tools = [SEARCH];
  real.info = {
    serverVersion: { name: "markets", version: "1.0.0" },
    instructions: "Be brief.",
    serverCapabilities: { tools: {}, prompts: {} },
  };
  queries = {
    "mockServers:getMock": () => stored({ tools: { search: { description: "Find things." } } }),
    "mockPolicy:getForMock": () => POLICY,
    "mockPolicy:getForProject": () => POLICY,
  };
  mutations = {
    "mockServers:createMock": () => ({ mockId: MOCK, version: 1, contentHash: "hash-1", created: true, loosened: [] }),
    "mockServers:saveMockVersion": () => ({ version: 3, contentHash: "hash-3", created: true, loosened: [] }),
    "mockPolicy:setForProject": (args) => ({ ...POLICY, forwarding: args.forwarding }),
  };
  mocks.query.mockImplementation(async (fn, args) => {
    const handler = queries[nameOf(fn)];
    if (!handler) throw new Error(`unexpected query ${nameOf(fn)}`);
    return handler(args);
  });
  mocks.mutation.mockImplementation(async (fn, args) => {
    const handler = mutations[nameOf(fn)];
    if (!handler) throw new Error(`unexpected mutation ${nameOf(fn)}`);
    return handler(args);
  });
});

describe("POST /mock-servers", () => {
  it("creates from a saved server, saving the base's listing with the version", async () => {
    const response = await request("POST", MOCKS, {
      body: { name: "markets (mock)", serverId: BASE, definition: { tools: { search: { description: "Find things." } } } },
    });
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({
      id: MOCK,
      version: 1,
      baseServerId: BASE,
      address: `https://inspector.test/api/web/mock-mcp/${MOCK}`,
      created: true,
      policy: { forwarding: "block", scope: "workspace" },
    });
    expect(calls(mocks.query, "mockPolicy:getForMock")).toEqual([{ mockId: MOCK }]);
    const [args] = calls(mocks.mutation, "mockServers:createMock");
    expect(args).toMatchObject({ projectId: PROJECT, baseServerId: BASE, name: "markets (mock)" });
    const listing = JSON.parse(args.discoveryJson);
    expect(listing.tools.map((t: { name: string }) => t.name)).toEqual(["search"]);
    expect(listing).toMatchObject({ instructions: "Be brief.", serverInfo: { name: "markets" }, prompts: [{ name: "summarize" }] });
  });

  it("creates from nothing without reading any server", async () => {
    const response = await request("POST", MOCKS, { body: { name: "empty", definition: { tools: {} } } });
    expect(response.status).toBe(201);
    expect(mocks.connect).not.toHaveBeenCalled();
    const [args] = calls(mocks.mutation, "mockServers:createMock");
    expect(args).not.toHaveProperty("baseServerId");
    expect(args).not.toHaveProperty("discoveryJson");
  });

  it("answers an identical retry with the same mock and 200", async () => {
    mutations["mockServers:createMock"] = () => ({ mockId: MOCK, version: 1, contentHash: "hash-1", created: false });
    const response = await request("POST", MOCKS, { body: { name: "m", definition: {} } });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ id: MOCK, created: false });
  });

  it("refuses an invalid definition before the backend is called, naming the path", async () => {
    const response = await request("POST", MOCKS, {
      body: { name: "m", definition: { tools: { a: { nope: true } } } },
    });
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.message).toContain("tools.a");
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("refuses a saved result that breaks its own output schema, naming the case, before the backend is called", async () => {
    const response = await request("POST", MOCKS, {
      body: {
        name: "m",
        definition: {
          tools: {
            t: {
              outputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
              answer: { from: "saved", cases: [{ result: { content: [], structuredContent: { n: "x" } } }] },
            },
          },
        },
      },
    });
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.details).toMatchObject({
      code: "MOCK_DEFINITION_INVALID",
      issues: [{ code: "invalid_value", path: "tools.t.answer.cases.0.result" }],
    });
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("names the flag when the backend says it is off", async () => {
    mutations["mockServers:createMock"] = () => {
      throw refusal("MOCK_SERVERS_FLAG_OFF", "off", { flag: "mock-servers-enabled" });
    };
    const response = await request("POST", MOCKS, { body: { name: "m", definition: {} } });
    expect(response.status).toBe(403);
    expect((await json(response)).message).toContain("mock-servers-enabled");
  });

  it("answers a name already taken with 409", async () => {
    mutations["mockServers:createMock"] = () => {
      throw refusal("CONFLICT", "A server with that name exists.");
    };
    expect((await request("POST", MOCKS, { body: { name: "m", definition: {} } })).status).toBe(409);
  });
});

describe("POST /mock-servers/:mockId/versions", () => {
  const path = `${MOCKS}/${MOCK}/versions`;

  it("sends a patch against the version the caller read, validated against the head first", async () => {
    const response = await request("POST", path, {
      body: { patch: { tools: { search: { description: "New." } } }, expectedVersion: 2 },
    });
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({ id: MOCK, version: 3, created: true });
    expect(calls(mocks.mutation, "mockServers:saveMockVersion")).toEqual([
      { mockId: MOCK, expectedVersion: 2, patchJson: JSON.stringify({ tools: { search: { description: "New." } } }) },
    ]);
  });

  it("refuses a patch whose result is not a valid definition, without calling the backend", async () => {
    const response = await request("POST", path, { body: { patch: { tools: { search: { nope: 1 } } }, expectedVersion: 2 } });
    expect(response.status).toBe(400);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("reports the head when the version is stale", async () => {
    mutations["mockServers:saveMockVersion"] = () => {
      throw refusal("MOCK_VERSION_STALE", "The mock is at version 5.", { headVersion: 5 });
    };
    const response = await request("POST", path, { body: { definition: {}, expectedVersion: 2 } });
    expect(response.status).toBe(409);
    expect((await json(response)).details).toMatchObject({ code: "MOCK_VERSION_STALE", headVersion: 5 });
  });

  it("answers an identical retry with the head, not a new version", async () => {
    mutations["mockServers:saveMockVersion"] = () => ({ version: 3, contentHash: "hash-3", created: false });
    const response = await request("POST", path, { body: { definition: {}, expectedVersion: 2 } });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ version: 3, created: false, policy: { forwarding: "block" } });
  });

  it("returns what a loosening save recorded, and the refusal when the caller may not loosen", async () => {
    mutations["mockServers:saveMockVersion"] = () => ({
      version: 3,
      contentHash: "h",
      created: true,
      loosened: [{ tool: "close", hints: ["readOnlyHint"] }],
    });
    expect(await json(request("POST", path, { body: { definition: {}, expectedVersion: 2 } }))).toMatchObject({
      loosened: [{ tool: "close", hints: ["readOnlyHint"] }],
    });
    mutations["mockServers:saveMockVersion"] = () => {
      throw refusal("MOCK_ANNOTATION_LOOSENING_FORBIDDEN", "Needs the manage tier.", { tools: [{ tool: "close", hints: ["readOnlyHint"] }] });
    };
    expect((await request("POST", path, { body: { definition: {}, expectedVersion: 2 } })).status).toBe(403);
  });

  it("takes exactly one of a definition and a patch", async () => {
    expect((await request("POST", path, { body: { expectedVersion: 2 } })).status).toBe(400);
    expect((await request("POST", path, { body: { definition: {}, patch: {}, expectedVersion: 2 } })).status).toBe(400);
  });

  it("does not find a mock through another project's path", async () => {
    queries["mockServers:getMock"] = () => stored({}, { projectId: "other" });
    expect((await request("POST", path, { body: { definition: {}, expectedVersion: 2 } })).status).toBe(404);
  });
});

describe("GET /mock-servers/:mockId", () => {
  it("is small: identity, version, base, policy, counts and the changed paths, with no definition", async () => {
    queries["mockServers:getMock"] = () =>
      stored({
        instructions: "Hi",
        tools: {
          search: { description: "Find.", annotations: { readOnlyHint: true }, params: { q: { fixed: "x" } } },
          old: { hidden: true },
        },
      });
    const body = await json(request("GET", `${MOCKS}/${MOCK}`));
    expect(body).toMatchObject({
      id: MOCK,
      version: 2,
      headVersion: 2,
      baseServerId: BASE,
      policy: POLICY,
      counts: { tools: 2, prompts: 0, resources: 0, resourceTemplates: 0 },
      changedPaths: {
        paths: ["instructions", "tools.search.description", "tools.search.annotations.readOnlyHint", "tools.search.params.q.fixed", "tools.old.hidden"],
        total: 5,
        truncated: false,
      },
    });
    expect(body).not.toHaveProperty("definition");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("bounds the changed paths and says so", async () => {
    const tools = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`t${i}`, { hidden: true }]));
    queries["mockServers:getMock"] = () => stored({ tools });
    const big = await json(request("GET", `${MOCKS}/${MOCK}`));
    expect(big.changedPaths).toMatchObject({ total: 150, truncated: true });
    expect(big.changedPaths.paths).toHaveLength(100);
  });

  it("reads a named version", async () => {
    await request("GET", `${MOCKS}/${MOCK}?version=1`);
    expect(calls(mocks.query, "mockServers:getMock")).toEqual([{ mockId: MOCK, version: 1 }]);
  });

  it("answers 404 for a mock the backend does not have", async () => {
    queries["mockServers:getMock"] = () => {
      throw refusal("MOCK_NOT_FOUND", "No such mock.");
    };
    expect((await request("GET", `${MOCKS}/${MOCK}`)).status).toBe(404);
  });
});

describe("the forwarding policy", () => {
  it("reads the policy in force for a mock", async () => {
    const body = await json(request("GET", `${MOCKS}/${MOCK}/forwarding-policy`));
    expect(body).toMatchObject({ forwarding: "block", scope: "workspace", projectId: PROJECT, mockId: MOCK });
  });

  it("reads the workspace's policy", async () => {
    expect(await json(request("GET", POLICY_PATH))).toMatchObject({ forwarding: "block", projectId: PROJECT });
    expect(calls(mocks.query, "mockPolicy:getForProject")).toEqual([{ projectId: PROJECT }]);
  });

  it("sets it for an admin", async () => {
    const response = await request("PUT", POLICY_PATH, { body: { forwarding: "allow" } });
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({ forwarding: "allow" });
    expect(calls(mocks.mutation, "mockPolicy:setForProject")).toEqual([{ projectId: PROJECT, forwarding: "allow" }]);
  });

  it("refuses anyone who is not an admin, and says so", async () => {
    mutations["mockPolicy:setForProject"] = () => {
      throw new ConvexError({ kind: "forbidden", message: "Only workspace admins can change this." });
    };
    const response = await request("PUT", POLICY_PATH, { body: { forwarding: "block" } });
    expect(response.status).toBe(403);
  });

  it("answers a non-admin with 403 and the backend's code", async () => {
    mutations["mockPolicy:setForProject"] = () => {
      throw refusal("MOCK_POLICY_ADMIN_ONLY", "Only a workspace admin can allow or block mock servers from calling real servers. Ask an admin to change it.");
    };
    const response = await request("PUT", POLICY_PATH, { body: { forwarding: "allow" } });
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("workspace admin"),
      details: { code: "MOCK_POLICY_ADMIN_ONLY" },
    });
  });

  it("refuses a value that is not allow or block", async () => {
    expect((await request("PUT", POLICY_PATH, { body: { forwarding: "maybe" } })).status).toBe(400);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});
