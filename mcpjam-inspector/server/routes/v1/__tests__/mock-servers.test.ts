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

import { readFileSync } from "node:fs";
import { MOCK_READ_LIMIT } from "@mcpjam/sdk/mocks";
import { MANY_TOOLS, generateTools } from "../../mcp/__tests__/helpers/many-tools-server.js";
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

function request(method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app.request(`https://inspector.test${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.token ?? "tok"}` },
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

  it("refuses a definition that leaves the base's tool impossible to call, naming the field and the fix", async () => {
    const response = await request("POST", MOCKS, {
      body: { name: "m", serverId: BASE, definition: { tools: { search: { params: { query: { hidden: true } } } } } },
    });
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.message).toContain("tools.search");
    expect(body.message).toContain("query");
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown property type", { inputSchema: { type: "object", properties: { id: { type: "bogus-type" } } } }, "tools.a.inputSchema.properties.id.type", "one of array, boolean"],
    ["a required list that is a string", { inputSchema: { type: "object", required: "id" } }, "tools.a.inputSchema.required", "required"],
  ])("refuses a tool with %s, naming the field path and what to change", async (_name, tool, path, phrase) => {
    const response = await request("POST", MOCKS, {
      body: { name: "m", definition: { tools: { a: { description: "x", ...tool } } } },
    });
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.message).toContain(phrase);
    expect(body.details.issues[0]).toMatchObject({ code: "invalid_schema", path });
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("refuses an output schema that does not compile, at the tool's outputSchema", async () => {
    const response = await request("POST", MOCKS, {
      body: {
        name: "m",
        definition: { tools: { a: { description: "x", outputSchema: { type: "object", properties: { n: { type: "numbr" } } } } } },
      },
    });
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.message).toContain("does not compile");
    expect(body.details.issues[0]).toMatchObject({ code: "invalid_value", path: "tools.a.outputSchema" });
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("refuses an invalid schema in a patch too", async () => {
    queries["mockServers:getMock"] = () => stored({ tools: { a: { description: "x" } } });
    const response = await request("POST", `${MOCKS}/${MOCK}/versions`, {
      body: { patch: { tools: { a: { inputSchema: { type: "object", required: "id" } } } }, expectedVersion: 2 },
    });
    expect(response.status).toBe(400);
    expect((await json(response)).details.issues[0].path).toBe("tools.a.inputSchema.required");
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("accepts a valid draft-07 schema and a dialect it cannot judge", async () => {
    const response = await request("POST", MOCKS, {
      body: {
        name: "m",
        definition: {
          tools: {
            a: { description: "x", inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
            b: { description: "y", inputSchema: { $schema: "https://example.com/own-dialect", type: "object", properties: { id: { type: "bogus" } } } },
          },
        },
      },
    });
    expect(response.status).toBe(201);
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

  it("checks the caller before the definition, so a caller the backend refuses never reaches the checks", async () => {
    queries["mockPolicy:getForProject"] = () => {
      throw refusal("SIGN_IN_REQUIRED", "Sign in to use mock servers.");
    };
    const response = await request("POST", MOCKS, {
      body: { name: "m", definition: { tools: { a: { nope: true } } } },
    });
    expect(response.status).toBe(401);
    expect((await json(response)).message).not.toContain("tools.a");
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("refuses a caller with mocks turned off before checking the definition", async () => {
    queries["mockPolicy:getForProject"] = () => {
      throw refusal("MOCK_SERVERS_FLAG_OFF", "off", { flag: "mock-servers-enabled" });
    };
    const response = await request("POST", MOCKS, {
      body: { name: "m", definition: { tools: { a: { nope: true } } } },
    });
    expect(response.status).toBe(403);
    expect((await json(response)).message).toContain("mock-servers-enabled");
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it.each([
    ["create", "mockServers:createMock", `${MOCKS}`, { name: "m", definition: {} }],
    ["save", "mockServers:saveMockVersion", `${MOCKS}/${MOCK}/versions`, { definition: {}, expectedVersion: 2 }],
    ["patch", "mockServers:saveMockVersion", `${MOCKS}/${MOCK}/versions`, { patch: { instructions: "x" }, expectedVersion: 2 }],
  ])("a seed the backend finds too big on %s is the SDK's 400, not a 500", async (_name, fn, path, body) => {
    mutations[fn] = () => {
      throw refusal("MOCK_SEED_TOO_MANY_RECORDS", "seed holds 2001 records; at most 2000.");
    };
    const response = await request("POST", path, { body });
    expect(response.status).toBe(400);
    const out = await json(response);
    expect(out.details).toMatchObject({
      code: "MOCK_DEFINITION_INVALID",
      issues: [{ code: "too_large", path: "seed" }],
    });
    expect(out.message).toContain('"seed"');
    expect(out.message).toContain("2001 records");
  });

  it("answers a name already taken with 409", async () => {
    mutations["mockServers:createMock"] = () => {
      throw refusal("CONFLICT", "A server with that name exists.");
    };
    expect((await request("POST", MOCKS, { body: { name: "m", definition: {} } })).status).toBe(409);
  });
});

/** A ticket mock whose declared record result cannot satisfy the tool's own output schema. */
const BROKEN_RECORDS = {
  seed: { tickets: { "123": { id: "123", status: "open" } } },
  tools: {
    lookup_ticket: {
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      outputSchema: { type: "object", properties: { status: { type: "number" } }, required: ["status"] },
      state: { op: "get", collection: "tickets", key: "{{input.id}}" },
    },
  },
};

describe("a record result is checked against the output schema when a version is saved", () => {
  it("refuses a create, naming the tool's state path, before the backend is called", async () => {
    const response = await request("POST", MOCKS, { body: { name: "tickets", definition: BROKEN_RECORDS } });
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.message).toContain("tools.lookup_ticket.state");
    expect(body.message).toContain("output schema");
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("refuses a version save the same way", async () => {
    const response = await request("POST", `${MOCKS}/${MOCK}/versions`, {
      body: { definition: BROKEN_RECORDS, expectedVersion: 2 },
    });
    expect(response.status).toBe(400);
    expect((await json(response)).message).toContain("tools.lookup_ticket.state");
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("accepts the same tool when its seed fits the schema", async () => {
    const fits = structuredClone(BROKEN_RECORDS);
    fits.tools.lookup_ticket.outputSchema.properties.status = { type: "string" } as never;
    const response = await request("POST", MOCKS, { body: { name: "tickets", definition: fits } });
    expect(response.status).toBe(201);
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

  it("checks a patch against the version's saved listing before saving", async () => {
    queries["mockServers:getMock"] = () =>
      stored(
        { tools: { search: { description: "Find things." } } },
        { discovery: { visibility: "project", listingJson: JSON.stringify({ tools: [SEARCH] }) } },
      );
    const response = await request("POST", path, {
      body: { patch: { tools: { search: { params: { query: { hidden: true } } } } }, expectedVersion: 2 },
    });
    expect(response.status).toBe(400);
    expect((await json(response)).message).toContain("tools.search");
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("leaves a stale save to the backend, even when its patch would leave a tool uncallable", async () => {
    queries["mockServers:getMock"] = () =>
      stored(
        { tools: { search: { description: "Find things." } } },
        { headVersion: 3, version: 3, discovery: { visibility: "project", listingJson: JSON.stringify({ tools: [SEARCH] }) } },
      );
    mutations["mockServers:saveMockVersion"] = () => {
      throw refusal("MOCK_VERSION_STALE", "The mock is at version 3.", { headVersion: 3 });
    };
    const response = await request("POST", path, {
      body: { patch: { tools: { search: { params: { query: { hidden: true } } } } }, expectedVersion: 2 },
    });
    expect(response.status).toBe(409);
    expect((await json(response)).details).toMatchObject({ code: "MOCK_VERSION_STALE", headVersion: 3 });
    // The same patch against the current version is still refused before the backend.
    mocks.mutation.mockClear();
    const current = await request("POST", path, {
      body: { patch: { tools: { search: { params: { query: { hidden: true } } } } }, expectedVersion: 3 },
    });
    expect(current.status).toBe(400);
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
  it("is small: identity, version, base, policy, counts and a page of changes, with no definition", async () => {
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
      view: "summary",
      id: MOCK,
      version: 2,
      headVersion: 2,
      baseServerId: BASE,
      policy: POLICY,
      // One change is one entry or one server-wide setting, not one leaf field.
      counts: { changes: 3, tools: 2, prompts: 0, resources: 0, resourceTemplates: 0 },
      changes: { page: { total: 3, end: true } },
    });
    expect(body.changes.items.map((c: { path: string }) => c.path)).toEqual(["instructions", "tools.old", "tools.search"]);
    expect(body.changes.items[2].fields).toEqual(["annotations.readOnlyHint", "description", "params.q.fixed"]);
    expect(body).not.toHaveProperty("definition");
    expect(mocks.connect).not.toHaveBeenCalled();
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

// ---- Bounded reads, field patch and refresh (I6) ----

const LISTING = (tools: unknown[]) => ({ visibility: "project", listingJson: JSON.stringify({ tools }) });
const LAST = "tool_202";
const readLimit = MOCK_READ_LIMIT;

/** A 202-tool mock with three changes, the last tool's description among them. */
function bigMock(over: Record<string, unknown> = {}) {
  const tools = generateTools(MANY_TOOLS);
  queries["mockServers:getMock"] = (args) =>
    stored(
      { instructions: "Use the tools.", tools: { tool_001: { description: "First." }, [LAST]: { description: "Old last." } } },
      { discovery: LISTING(tools), version: args.version ?? 2, ...over },
    );
}

describe("bounded reads of a 202-tool mock", () => {
  beforeEach(() => bigMock());

  it("finds the last tool by name and by search, then reads its description by path", async () => {
    const found = await json(request("GET", `${MOCKS}/${MOCK}?family=tools&search=202`));
    expect(found).toMatchObject({ view: "list", listing: "saved", entries: [{ name: LAST, kind: "edited" }], page: { end: true, total: 1 } });
    const entry = await json(request("GET", `${MOCKS}/${MOCK}?family=tools&name=${LAST}`));
    expect(entry).toMatchObject({ view: "entry", name: LAST, stated: { description: "Old last." } });
    const value = await json(request("GET", `${MOCKS}/${MOCK}?family=tools&name=${LAST}&path=description`));
    expect(value).toMatchObject({ view: "value", value: "Old last.", stated: true, path: ["description"] });
    expect((await request("GET", `${MOCKS}/${MOCK}?family=tools&name=nope`)).status).toBe(404);
  });

  it("pages the whole listing within the budget, ending explicitly, on the version it started on", async () => {
    const names: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const response = await request("GET", `${MOCKS}/${MOCK}?family=tools${cursor ? `&cursor=${cursor}` : ""}`);
      const raw = await response.text();
      expect(JSON.stringify(JSON.parse(raw), null, 2).length).toBeLessThanOrEqual(readLimit + 300);
      const page = JSON.parse(raw);
      names.push(...page.entries.map((e: { name: string }) => e.name));
      pages += 1;
      // The head moves on after the first page; the rest still reads version 2.
      queries["mockServers:getMock"] = (args) =>
        stored({}, { discovery: LISTING(generateTools(MANY_TOOLS)), version: args.version ?? 3, headVersion: 3 });
      if (page.page.end) {
        expect(page.page.nextCursor).toBeUndefined();
        break;
      }
      cursor = page.page.nextCursor;
    }
    expect(pages).toBeGreaterThan(1);
    expect(new Set(names).size).toBe(MANY_TOOLS);
    const versions = calls(mocks.query, "mockServers:getMock").map((a) => a.version);
    expect(versions[0]).toBeUndefined();
    expect(versions.slice(1).every((v) => v === 2)).toBe(true);
  });

  it("reconstructs an oversized field across chunks without loss", async () => {
    const long = `${'say "x"\n\ttab 😀 '.repeat(9000)}end`;
    queries["mockServers:getMock"] = () =>
      stored({ tools: { [LAST]: { description: long } } }, { discovery: LISTING(generateTools(MANY_TOOLS)) });
    let joined = "";
    let cursor: string | undefined;
    for (;;) {
      const response = await request("GET", `${MOCKS}/${MOCK}?family=tools&name=${LAST}&path=description${cursor ? `&cursor=${cursor}` : ""}`);
      const page = (await response.json()) as Record<string, any>;
      expect(JSON.stringify(page, null, 2).length).toBeLessThanOrEqual(readLimit + 300);
      joined += page.value;
      if (page.page.end) break;
      cursor = page.page.nextCursor;
    }
    expect(joined).toBe(long);
  });

  it("refuses a cursor from another caller or with another query", async () => {
    const first = await json(request("GET", `${MOCKS}/${MOCK}?family=tools`));
    const cursor = first.page.nextCursor;
    const other = await request("GET", `${MOCKS}/${MOCK}?family=tools&cursor=${cursor}`, { token: "someone-else" });
    expect(other.status).toBe(400);
    expect((await json(other)).details).toMatchObject({ code: "MOCK_CURSOR_REFUSED", reason: "other_caller" });
    const query = await request("GET", `${MOCKS}/${MOCK}?family=tools&search=tool&cursor=${cursor}`);
    expect((await json(query)).details).toMatchObject({ reason: "other_query" });
    const bad = await request("GET", `${MOCKS}/${MOCK}?family=tools&cursor=garbage`);
    expect((await json(bad)).details).toMatchObject({ reason: "malformed" });
  });

  it("says what is wrong with a selector", async () => {
    expect((await request("GET", `${MOCKS}/${MOCK}?name=a`)).status).toBe(400);
    expect((await request("GET", `${MOCKS}/${MOCK}?search=a`)).status).toBe(400);
  });

  it("reads a mock whose listing is another member's as definition only, and says so", async () => {
    queries["mockServers:getMock"] = () => stored({ tools: { a: { description: "x" } } }, { discovery: null, hasDiscovery: true });
    expect(await json(request("GET", `${MOCKS}/${MOCK}?family=tools`))).toMatchObject({ listing: "private", entries: [{ name: "a", kind: "added" }] });
  });
});

describe("PATCH /mock-servers/:mockId", () => {
  beforeEach(() => bigMock());

  it("changes the last tool's description in one patch, sending only the path and value", async () => {
    const response = await request("PATCH", `${MOCKS}/${MOCK}`, {
      body: { expectedVersion: 2, family: "tools", name: LAST, path: ["description"], value: "Last, now accurate." },
    });
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({ id: MOCK, version: 3, path: ["tools", LAST, "description"] });
    const [args] = calls(mocks.mutation, "mockServers:saveMockVersion");
    expect(args.expectedVersion).toBe(2);
    expect(JSON.parse(args.definitionJson).tools[LAST]).toEqual({ description: "Last, now accurate." });
    expect(JSON.parse(args.definitionJson).tools.tool_001).toEqual({ description: "First." });
  });

  it("answers the head when the same patch already landed, and refuses a stale one with the head", async () => {
    const same = await request("PATCH", `${MOCKS}/${MOCK}`, {
      body: { expectedVersion: 1, family: "tools", name: LAST, path: ["description"], value: "Old last." },
    });
    expect(same.status).toBe(200);
    expect(await json(same)).toMatchObject({ created: false, version: 2 });
    const stale = await request("PATCH", `${MOCKS}/${MOCK}`, {
      body: { expectedVersion: 1, family: "tools", name: LAST, path: ["description"], value: "Different." },
    });
    expect(stale.status).toBe(409);
    expect((await json(stale)).details).toMatchObject({ code: "MOCK_VERSION_STALE", headVersion: 2 });
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("removes a path, and refuses an edit that makes the definition invalid with its path", async () => {
    const removed = await request("PATCH", `${MOCKS}/${MOCK}`, { body: { expectedVersion: 2, family: "tools", name: LAST, path: ["description"], remove: true } });
    expect(removed.status).toBe(201);
    expect(JSON.parse(calls(mocks.mutation, "mockServers:saveMockVersion")[0].definitionJson).tools).not.toHaveProperty(LAST);
    vi.clearAllMocks();
    const invalid = await request("PATCH", `${MOCKS}/${MOCK}`, { body: { expectedVersion: 2, family: "tools", name: LAST, path: ["description"], value: 5 } });
    expect(invalid.status).toBe(400);
    expect((await json(invalid)).message).toContain(`tools.${LAST}.description`);
    const unclear = await request("PATCH", `${MOCKS}/${MOCK}`, { body: { expectedVersion: 2, name: LAST, value: 1 } });
    expect(unclear.status).toBe(400);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});

describe("POST /mock-servers/:mockId/refresh", () => {
  const path = `${MOCKS}/${MOCK}/refresh`;
  const search = { name: "search", description: "Old.", inputSchema: { type: "object", properties: { q: { type: "string" } } } };

  it("previews what changed on the real server and which overrides no longer fit, saving nothing", async () => {
    queries["mockServers:getMock"] = () =>
      stored({ tools: { find: { answer: { tool: "gone" } } } }, { discovery: LISTING([search, { name: "gone", inputSchema: { type: "object" } }]) });
    real.tools = [{ ...SEARCH }, { name: "fresh", inputSchema: { type: "object" } }];
    const body = await json(request("POST", path, { body: { expectedVersion: 2 } }));
    expect(body).toMatchObject({
      view: "refresh",
      applied: false,
      listing: "saved",
      brokenTotal: 1,
      brokenOverrides: [{ path: "tools.find.answer.tool", code: "target_missing" }],
      differences: [
        { family: "tools", added: ["fresh"], removed: ["gone"], changed: ["search"] },
        // The live server also has a prompt the saved listing never captured.
        { family: "prompts", added: ["summarize"] },
      ],
    });
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("saves the new listing against expectedVersion when asked, and refuses a stale version", async () => {
    const applied = await request("POST", path, { body: { expectedVersion: 2, apply: true } });
    expect(applied.status).toBe(201);
    expect(await json(applied)).toMatchObject({ applied: true, version: 3, saved: { version: 3 } });
    const [args] = calls(mocks.mutation, "mockServers:saveMockVersion");
    expect(args).toMatchObject({ mockId: MOCK, expectedVersion: 2, patchJson: "{}" });
    expect(JSON.parse(args.discoveryJson).tools[0].name).toBe("search");
    const stale = await request("POST", path, { body: { expectedVersion: 1 } });
    expect(stale.status).toBe(409);
  });

  it("needs a real server to read", async () => {
    queries["mockServers:getMock"] = () => stored({}, { baseServerId: null });
    expect((await request("POST", path, { body: { expectedVersion: 2 } })).status).toBe(400);
  });
});

// The other surfaces (SDK, CLI, MCP) are tested against these same bodies, so
// create, read and patch return the same result on every one.
describe("the shared surface fixture", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../../../../../sdk/tests/fixtures/mock-surfaces.json", import.meta.url), "utf8"),
  ) as Record<string, any>;

  beforeEach(() => {
    queries["mockServers:getMock"] = () =>
      stored(
        { instructions: "Use the tools.", tools: { tool_001: { description: "First." } } },
        { discovery: LISTING(generateTools(3)) },
      );
  });

  it("uses the ids the fixture names", () => {
    expect(fixture.ids).toEqual({ project: PROJECT, base: BASE, mock: MOCK });
  });

  it("creates", async () => {
    const response = await request("POST", MOCKS, {
      body: { name: "markets (mock)", serverId: BASE, definition: { instructions: "Use the tools." } },
    });
    expect(await json(response)).toEqual(fixture.created);
  });

  it("answers a create and a save with the counts and a bounded change page a read can continue", async () => {
    const tools = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`t${i}`, { hidden: true }]));
    const created = await json(request("POST", MOCKS, { body: { name: "m", definition: { tools } } }));
    expect(created.counts).toMatchObject({ changes: 60, tools: 60 });
    expect(created.changes.page).toMatchObject({ offset: 0, count: 50, total: 60, end: false });
    expect(created.changes.items).toHaveLength(50);
    queries["mockServers:getMock"] = () => stored({ tools }, { version: 1, headVersion: 1 });
    const next = await json(request("GET", `${MOCKS}/${MOCK}?cursor=${created.changes.page.nextCursor}`));
    expect(next.changes.page).toMatchObject({ offset: 50, count: 10, end: true });
    const saved = await json(request("POST", `${MOCKS}/${MOCK}/versions`, { body: { definition: { tools }, expectedVersion: 2 } }));
    expect(saved).toMatchObject({ version: 3, policy: { forwarding: "block" }, counts: { changes: 60 } });
  });

  it("reads the summary and one field", async () => {
    expect(await json(request("GET", `${MOCKS}/${MOCK}`))).toEqual(fixture.summary);
    expect(await json(request("GET", `${MOCKS}/${MOCK}?family=tools&name=tool_001&path=description`))).toEqual(fixture.value);
  });

  it("patches one path", async () => {
    const response = await request("PATCH", `${MOCKS}/${MOCK}`, {
      body: { expectedVersion: 2, family: "tools", name: "tool_001", path: ["description"], value: "Second." },
    });
    expect(await json(response)).toEqual(fixture.patched);
  });
});
