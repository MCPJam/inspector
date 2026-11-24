/**
 * The mock server routes: create, save a version, read one, and the mock mark
 * on the server list.
 *
 * Convex is mocked at `convex/browser` and the live connection at
 * `runEphemeralConnection`, so these prove the gateway: what it checks before
 * the backend is called, what it forwards, and how each backend refusal is
 * answered. The backend's own rules (tiers, the flag, the caps) are covered in
 * the backend's tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  mockServerAddress: (mockId: string) =>
    `https://inspector.test/api/web/mock-mcp/${mockId}`,
}));
vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: mocks.guest,
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(function () {
    return { setAuth: vi.fn(), query: mocks.query, mutation: mocks.mutation };
  }),
}));
// The live connection to the real server, as the caller. The fake manager
// answers `tools/list` and the handshake from `real`.
vi.mock("../../web/auth.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../web/auth.js")>(
      "../../web/auth.js",
    );
  return {
    ...actual,
    runEphemeralConnection: async (
      _c: unknown,
      rawBody: Record<string, unknown>,
      schema: { parse(value: unknown): { serverId: string } },
      fn: (
        manager: unknown,
        body: { serverId: string },
        refused: object,
      ) => Promise<unknown>,
    ) => {
      const body = schema.parse(rawBody);
      mocks.connect(body);
      if (real.failure) throw real.failure;
      const manager = {
        listTools: async () => ({ tools: real.tools }),
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

const SEARCH = {
  name: "search",
  description: "Search the index.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" }, lang: { type: "string" } },
    required: ["query", "lang"],
  },
};
const real: { tools: unknown[]; info: unknown; failure?: Error } = {
  tools: [],
  info: undefined,
};

type Handler = (args: Record<string, any>) => unknown;
let queries: Record<string, Handler>;
let mutations: Record<string, Handler>;

const nameOf = (value: unknown) => getFunctionName(value as never);
const calls = (mock: typeof mocks.mutation, name: string) =>
  mock.mock.calls.filter(([fn]) => nameOf(fn) === name).map(([, args]) => args);

function request(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
) {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app.request(`https://inspector.test${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer tok",
      ...opts.headers,
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function json(response: Response | Promise<Response>) {
  return (await (await response).json()) as Record<string, any>;
}

const refusal = (code: string, message: string, extra: object = {}) =>
  new ConvexError({ code, message, ...extra });
const stored = (definition: object, over: Record<string, unknown> = {}) => ({
  mockId: MOCK,
  projectId: PROJECT,
  name: "markets (mock)",
  baseServerId: BASE,
  headVersion: 2,
  version: 2,
  contentHash: "hash-2",
  definitionJson: JSON.stringify(definition),
  createdAt: 5,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://convex.example.com");
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex-http.example.com");
  mocks.guest.mockResolvedValue({ valid: false });
  real.tools = [SEARCH];
  real.info = {
    serverVersion: { name: "markets", version: "1.0.0" },
    instructions: "Be brief.",
    serverCapabilities: { tools: {} },
  };
  real.failure = undefined;
  queries = {
    "mockServers:getMock": () =>
      stored({ tools: { search: { description: "Find things." } } }),
  };
  mutations = {
    "mockServers:createMock": () => ({
      mockId: MOCK,
      version: 1,
      contentHash: "hash-1",
    }),
    "mockServers:saveMockVersion": () => ({
      version: 3,
      contentHash: "hash-3",
      created: true,
    }),
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

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /projects/:projectId/mock-servers", () => {
  const body = {
    name: "markets (mock)",
    serverId: BASE,
    definition: { tools: { search: { description: "Find things." } } },
  };

  it("creates version 1, forwards the definition as JSON text, and answers the address and the change list", async () => {
    const res = await request("POST", MOCKS, { body });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      id: MOCK,
      name: "markets (mock)",
      projectId: PROJECT,
      baseServerId: BASE,
      address: `https://inspector.test/api/web/mock-mcp/${MOCK}`,
      version: 1,
      contentHash: "hash-1",
      created: true,
      dryRun: false,
      changes: [{ target: "tool", name: "search", kind: "added" }],
    });
    expect(calls(mocks.mutation, "mockServers:createMock")).toEqual([
      {
        projectId: PROJECT,
        baseServerId: BASE,
        name: "markets (mock)",
        definitionJson: JSON.stringify(body.definition),
      },
    ]);
  });

  it("creates a mock from nothing without connecting to any server", async () => {
    const res = await request("POST", MOCKS, {
      body: { name: "scratch", definition: {} },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).baseServerId).toBeNull();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(calls(mocks.mutation, "mockServers:createMock")[0]).toEqual({
      projectId: PROJECT,
      name: "scratch",
      definitionJson: "{}",
    });
  });

  it("refuses an invalid definition before connecting or calling the backend", async () => {
    const res = await request("POST", MOCKS, {
      body: { ...body, definition: { tools: { search: { colour: "red" } } } },
    });
    expect(res.status).toBe(400);
    const error = await res.json();
    expect(error.details).toMatchObject({
      code: "MOCK_DEFINITION_INVALID",
      issues: [{ code: "unknown_field" }],
    });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("refuses a change that leaves a real tool uncallable, naming the parameter", async () => {
    const hidden = {
      tools: { search: { params: { lang: { hidden: true } } } },
    };
    const res = await request("POST", MOCKS, {
      body: { ...body, definition: hidden },
    });
    expect(res.status).toBe(400);
    const error = await res.json();
    expect(error.message).toContain("lang");
    expect(error.details.issues[0].code).toBe("uncallable_input");
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("answers the flag being off with the backend's FEATURE_UNAVAILABLE", async () => {
    mutations["mockServers:createMock"] = () => {
      throw refusal(
        "FEATURE_UNAVAILABLE",
        "Climbs is not available for your organization.",
        { feature: "climbs" },
      );
    };
    const res = await request("POST", MOCKS, { body });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: "FORBIDDEN",
      details: { code: "FEATURE_UNAVAILABLE", feature: "climbs" },
    });
  });

  it("answers a member below the edit tier with the backend's refusal", async () => {
    mutations["mockServers:createMock"] = () => {
      throw new ConvexError({
        kind: "forbidden",
        action: "mock.write",
        message: "Insufficient permissions for mock.write: requires editor",
      });
    };
    const res = await request("POST", MOCKS, { body });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toContain("mock.write");
  });

  it("answers a taken name 409 and a bad base server 400, each with the backend's code", async () => {
    mutations["mockServers:createMock"] = () => {
      throw refusal("CONFLICT", "Name taken.");
    };
    expect((await request("POST", MOCKS, { body })).status).toBe(409);
    mutations["mockServers:createMock"] = () => {
      throw refusal(
        "MOCK_BASE_SERVER_INVALID",
        "A mock cannot sit in front of another mock.",
      );
    };
    const res = await request("POST", MOCKS, { body });
    expect(res.status).toBe(400);
    expect((await res.json()).details.code).toBe("MOCK_BASE_SERVER_INVALID");
  });

  it("answers a real server that cannot be reached as every live operation does, before any write", async () => {
    real.failure = new Error("connect ECONNREFUSED 10.0.0.1:443");
    const res = await request("POST", MOCKS, { body });
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("SERVER_UNREACHABLE");
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("denies a guest", async () => {
    mocks.guest.mockResolvedValue({ valid: true, guestId: "guest_1" });
    expect((await request("POST", MOCKS, { body })).status).toBe(401);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("rejects unknown body fields and a missing name", async () => {
    expect(
      (await request("POST", MOCKS, { body: { ...body, projectId: "other" } }))
        .status,
    ).toBe(400);
    expect(
      (await request("POST", MOCKS, { body: { definition: {} } })).status,
    ).toBe(400);
  });
});

describe("POST /projects/:projectId/mock-servers/:mockId/versions", () => {
  const VERSIONS = `${MOCKS}/${MOCK}/versions`;
  const next = { tools: { search: { description: "Find anything." } } };

  it("saves a whole definition at the version it read", async () => {
    const res = await request("POST", VERSIONS, {
      body: { definition: next, expectedVersion: 2 },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      id: MOCK,
      version: 3,
      contentHash: "hash-3",
      created: true,
      dryRun: false,
      changes: [{ target: "tool", name: "search", kind: "changed" }],
    });
    expect(calls(mocks.mutation, "mockServers:saveMockVersion")).toEqual([
      {
        mockId: MOCK,
        definitionJson: JSON.stringify(next),
        expectedVersion: 2,
      },
    ]);
  });

  it("applies a merge patch over the head and sends the whole result", async () => {
    const res = await request("POST", VERSIONS, {
      body: {
        patch: {
          tools: { search: { description: "Find anything.", title: "Search" } },
        },
        expectedVersion: 2,
      },
    });
    expect(res.status).toBe(201);
    const [sent] = calls(mocks.mutation, "mockServers:saveMockVersion");
    expect(JSON.parse(sent.definitionJson)).toEqual({
      tools: { search: { description: "Find anything.", title: "Search" } },
    });
    expect(sent).not.toHaveProperty("patchJson");
  });

  it("removes a key a patch sets to null", async () => {
    await request("POST", VERSIONS, {
      body: { patch: { tools: { search: null } }, expectedVersion: 2 },
    });
    const [sent] = calls(mocks.mutation, "mockServers:saveMockVersion");
    expect(JSON.parse(sent.definitionJson)).toEqual({ tools: {} });
  });

  it("with dryRun answers the change list and saves nothing", async () => {
    const res = await request("POST", VERSIONS, {
      body: { definition: next, expectedVersion: 2, dryRun: true },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      dryRun: true,
      created: true,
      version: 2,
      changes: [{ target: "tool", name: "search", kind: "changed" }],
    });
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("with dryRun still refuses an invalid change and an uncallable one", async () => {
    const hidden = {
      tools: { search: { params: { lang: { hidden: true } } } },
    };
    expect(
      (
        await request("POST", VERSIONS, {
          body: { definition: hidden, expectedVersion: 2, dryRun: true },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("POST", VERSIONS, {
          body: { definition: { nope: 1 }, expectedVersion: 2, dryRun: true },
        })
      ).status,
    ).toBe(400);
  });

  it("refuses a stale expectedVersion, naming the head, before connecting or saving", async () => {
    const res = await request("POST", VERSIONS, {
      body: { definition: next, expectedVersion: 1 },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "CONFLICT",
      details: { code: "MOCK_VERSION_STALE", headVersion: 2 },
    });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.mutation).not.toHaveBeenCalled();
  });

  it("lets a retried save of the head through, so the backend answers created: false", async () => {
    mutations["mockServers:saveMockVersion"] = () => ({
      version: 2,
      contentHash: "hash-2",
      created: false,
    });
    const res = await request("POST", VERSIONS, {
      body: {
        definition: { tools: { search: { description: "Find things." } } },
        expectedVersion: 1,
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      created: false,
      version: 2,
      changes: [],
    });
  });

  it("answers a race the backend catches with the head it names", async () => {
    mutations["mockServers:saveMockVersion"] = () => {
      throw refusal("MOCK_VERSION_STALE", "The mock moved. Read it again.", {
        headVersion: 3,
      });
    };
    const res = await request("POST", VERSIONS, {
      body: { definition: next, expectedVersion: 2 },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).details).toEqual({
      code: "MOCK_VERSION_STALE",
      headVersion: 3,
    });
  });

  it("answers the flag off, the manage tier for a loosened annotation, and a missing mock", async () => {
    mutations["mockServers:saveMockVersion"] = () => {
      throw refusal(
        "FEATURE_UNAVAILABLE",
        "Climbs is not available for your organization.",
        { feature: "climbs" },
      );
    };
    expect(
      (
        await json(
          request("POST", VERSIONS, {
            body: { definition: next, expectedVersion: 2 },
          }),
        )
      ).details.code,
    ).toBe("FEATURE_UNAVAILABLE");
    mutations["mockServers:saveMockVersion"] = () => {
      throw new ConvexError({
        kind: "forbidden",
        action: "tool.destructive.enable",
        message: "Loosening a safety annotation needs the manage tier.",
      });
    };
    expect(
      (
        await request("POST", VERSIONS, {
          body: { definition: next, expectedVersion: 2 },
        })
      ).status,
    ).toBe(403);
    queries["mockServers:getMock"] = () => {
      throw refusal("MOCK_NOT_FOUND", "No mock server with that id.");
    };
    expect(
      (
        await request("POST", VERSIONS, {
          body: { definition: next, expectedVersion: 2 },
        })
      ).status,
    ).toBe(404);
  });

  it("needs exactly one of definition and patch", async () => {
    expect(
      (await request("POST", VERSIONS, { body: { expectedVersion: 2 } }))
        .status,
    ).toBe(400);
    expect(
      (
        await request("POST", VERSIONS, {
          body: { definition: next, patch: {}, expectedVersion: 2 },
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("POST", VERSIONS, { body: { definition: next } })).status,
    ).toBe(400);
  });

  it("does not reach another project's mock", async () => {
    queries["mockServers:getMock"] = () =>
      stored({}, { projectId: "p2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    expect(
      (
        await request("POST", VERSIONS, {
          body: { definition: next, expectedVersion: 2 },
        })
      ).status,
    ).toBe(404);
    expect(mocks.mutation).not.toHaveBeenCalled();
  });
});

describe("GET /projects/:projectId/mock-servers/:mockId", () => {
  const ONE = `${MOCKS}/${MOCK}`;

  it("reads the head with its address, definition and the real server's current values", async () => {
    queries["mockServers:getMock"] = () =>
      stored({
        serverInfo: { name: "Markets (test)" },
        instructions: "Be terse.",
        tools: {
          search: {
            description: "Find things.",
            params: { lang: { description: "Language." } },
          },
        },
      });
    const res = await request("GET", ONE);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: MOCK,
      version: 2,
      headVersion: 2,
      address: `https://inspector.test/api/web/mock-mcp/${MOCK}`,
      definition: { tools: { search: { description: "Find things." } } },
      realServer: {
        status: "read",
        serverInfo: { name: "markets", version: "1.0.0" },
        instructions: "Be brief.",
        tools: [
          {
            tool: "search",
            realTool: "search",
            found: true,
            current: {
              description: "Search the index.",
              "params.lang": { type: "string" },
            },
          },
        ],
      },
    });
    expect(calls(mocks.query, "mockServers:getMock")).toEqual([
      { mockId: MOCK },
    ]);
  });

  it("reads a named version and lists what changed since another", async () => {
    queries["mockServers:getMock"] = ({ version }) =>
      version === 1
        ? stored({ tools: { search: { description: "Old." } } }, { version: 1 })
        : stored(
            { tools: { search: { description: "New." } } },
            { version: 2 },
          );
    const body = await json(request("GET", `${ONE}?version=2&since=1`));
    expect(body.sinceVersion).toBe(1);
    expect(body.changes).toMatchObject([
      { target: "tool", name: "search", kind: "changed" },
    ]);
    expect(calls(mocks.query, "mockServers:getMock")).toEqual([
      { mockId: MOCK, version: 2 },
      { mockId: MOCK, version: 1 },
    ]);
  });

  it("is still readable when the real server is not, without leaking why", async () => {
    real.failure = new Error("connect ECONNREFUSED 10.0.0.1:443");
    const res = await request("GET", ONE);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.realServer).toMatchObject({ status: "unreachable", tools: [] });
    expect(JSON.stringify(body)).not.toContain("10.0.0.1");
    expect(body.definition).toBeDefined();
  });

  it("reads a mock from nothing without connecting", async () => {
    queries["mockServers:getMock"] = () => stored({}, { baseServerId: null });
    expect((await json(request("GET", ONE))).realServer).toEqual({
      status: "none",
      tools: [],
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("answers a missing version and another project's mock 404", async () => {
    queries["mockServers:getMock"] = () => {
      throw refusal("MOCK_VERSION_NOT_FOUND", "No version 9.");
    };
    expect((await request("GET", `${ONE}?version=9`)).status).toBe(404);
    queries["mockServers:getMock"] = () =>
      stored({}, { projectId: "p2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
    expect((await request("GET", ONE)).status).toBe(404);
  });

  it("rejects a version that is not a positive integer", async () => {
    expect((await request("GET", `${ONE}?version=0`)).status).toBe(400);
  });
});

describe("GET /projects/:projectId/servers", () => {
  const LIST = `/api/v1/projects/${PROJECT}/servers`;
  const items = [
    { id: BASE, name: "markets", projectId: PROJECT },
    { id: MOCK, name: "markets (mock)", projectId: PROJECT },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/project-servers")
          return Response.json({ items });
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    queries["mockServers:listMocks"] = () => [
      {
        mockId: MOCK,
        name: "markets (mock)",
        baseServerId: BASE,
        headVersion: 2,
      },
    ];
  });
  afterEach(() => vi.unstubAllGlobals());

  it("marks the mock and leaves the real server unmarked", async () => {
    const body = await json(request("GET", LIST));
    expect(body.items[0]).toEqual(items[0]);
    expect(body.items[1]).toEqual({
      ...items[1],
      mock: { baseServerId: BASE, headVersion: 2 },
    });
  });

  it("still lists when the marks cannot be read", async () => {
    queries["mockServers:listMocks"] = () => {
      throw new Error(
        "Could not find public function for 'mockServers:listMocks'",
      );
    };
    const res = await request("GET", LIST);
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual(items);
  });

  it("adds no marks for a guest", async () => {
    mocks.guest.mockResolvedValue({ valid: true, guestId: "guest_1" });
    const res = await request("GET", LIST);
    if (res.status === 200) expect((await res.json()).items).toEqual(items);
    expect(calls(mocks.query, "mockServers:listMocks")).toEqual([]);
  });
});

describe("GET /projects/:projectId/mock-servers/:mockId, what can change", () => {
  it("ranks everything the mock can change on the real server, with who reads each, and never fails the read on it", async () => {
    const res = await request("GET", `${MOCKS}/${MOCK}`);
    const body = await json(res);
    expect(body.whatCanChange.length).toBeGreaterThan(0);
    const description = body.whatCanChange.find((entry: any) => entry.where.mockPath === "tools.search.description");
    expect(description).toMatchObject({ current: "Search the index.", readByAnyClient: true });
    expect(description.readBy.map((reader: any) => reader.client)).toEqual(
      expect.arrayContaining(["mcpjam", "claude-code", "codex"]),
    );

    real.failure = new Error("connect ECONNREFUSED 10.0.0.5:443");
    const down = await json(request("GET", `${MOCKS}/${MOCK}`));
    expect(down.realServer.status).toBe("unreachable");
    expect(down.whatCanChange).toBeUndefined();
  });
});
