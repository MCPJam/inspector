import { describe, expect, it, vi } from "vitest";
import {
  OPERATION_FEATURES,
  PlatformApiClient,
  createMockServerOperation,
  getMockServerOperation,
  isOperationAvailable,
  updateMockServerOperation,
} from "../../src/platform/index.js";

const PROJECT = {
  id: "project-1",
  name: "Acme",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};
const REAL = {
  id: "server-1",
  name: "markets",
  projectId: PROJECT.id,
  transportType: "http",
  url: "https://x.test/mcp",
};
const MOCK = {
  id: "mock-1",
  name: "markets (mock)",
  projectId: PROJECT.id,
  transportType: "http",
  url: "https://mock.mcpjam.invalid/mock-1",
};

const SAVED = {
  id: "mock-1",
  name: "markets (mock)",
  projectId: PROJECT.id,
  baseServerId: "server-1",
  address: "https://app.test/api/web/mock-mcp/mock-1",
  version: 1,
  contentHash: "h",
  created: true,
  dryRun: false,
  changes: [],
};

/** A client whose API answers from `routes`, recording each request body. */
function clientWith(routes: Record<string, unknown>) {
  const bodies: unknown[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    if (key.endsWith("/servers")) return Response.json({ items: [REAL, MOCK] });
    if (key in routes) {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return Response.json(routes[key]);
    }
    throw new Error(`unexpected ${key}`);
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  const lastUrl = () => new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
  return { client, bodies, lastUrl };
}

const CONTEXT = { signal: new AbortController().signal };
const MOCKS = "/api/v1/projects/project-1/mock-servers";

describe("mock server operations", () => {
  it("creates a mock in front of a saved server, resolved by name", async () => {
    const { client, bodies } = clientWith({ [`POST ${MOCKS}`]: SAVED });
    const definition = { tools: { echo: { description: "Say it back." } } };

    const result = await createMockServerOperation.execute(
      { server: "markets", name: "markets (mock)", definition },
      { client, ...CONTEXT }
    );

    expect(bodies).toEqual([
      { name: "markets (mock)", serverId: "server-1", definition },
    ]);
    expect(result).toEqual({
      ...SAVED,
      project: expect.objectContaining({ id: "project-1" }),
    });
  });

  it("creates a mock from nothing when no server is named", async () => {
    const { client, bodies } = clientWith({
      [`POST ${MOCKS}`]: { ...SAVED, baseServerId: null },
    });

    await createMockServerOperation.execute(
      { name: "scratch", definition: {} },
      { client, ...CONTEXT }
    );

    expect(bodies).toEqual([{ name: "scratch", definition: {} }]);
  });

  it("saves the next version by the mock's name, sending the version it read", async () => {
    const { client, bodies } = clientWith({
      [`POST ${MOCKS}/mock-1/versions`]: { ...SAVED, version: 2 },
    });

    const result = await updateMockServerOperation.execute(
      {
        mock: "markets (mock)",
        patch: { tools: { echo: null } },
        expectedVersion: 1,
        dryRun: true,
      },
      { client, ...CONTEXT }
    );

    expect(bodies).toEqual([
      { patch: { tools: { echo: null } }, expectedVersion: 1, dryRun: true },
    ]);
    expect(result.version).toBe(2);
  });

  it("reads one version and what changed since another", async () => {
    const { client, lastUrl } = clientWith({
      [`GET ${MOCKS}/mock-1`]: {
        ...SAVED,
        headVersion: 3,
        realServer: { status: "none", tools: [] },
      },
    });

    const result = await getMockServerOperation.execute(
      { mock: "mock-1", version: 3, sinceVersion: 1 },
      { client, ...CONTEXT }
    );

    expect(lastUrl().searchParams.get("version")).toBe("3");
    expect(lastUrl().searchParams.get("since")).toBe("1");
    expect(result.realServer.status).toBe("none");
  });

  it("names the missing server when the selector matches nothing", async () => {
    const { client } = clientWith({});

    await expect(
      createMockServerOperation.execute(
        { server: "nope", name: "m", definition: {} },
        { client, ...CONTEXT }
      )
    ).rejects.toThrow(/Server "nope" was not found/);
  });
});

describe("mock server inputs", () => {
  it("needs exactly one of a definition and a patch, and the version read", () => {
    const base = { mock: "m", expectedVersion: 1 };
    const parse = (input: object) =>
      updateMockServerOperation.inputSchema.safeParse(input).success;
    expect(parse({ ...base, definition: {} })).toBe(true);
    expect(parse({ ...base, patch: {} })).toBe(true);
    expect(parse(base)).toBe(false);
    expect(parse({ ...base, definition: {}, patch: {} })).toBe(false);
    expect(parse({ mock: "m", definition: {} })).toBe(false);
    expect(parse({ ...base, definition: {}, expectedVersion: 0 })).toBe(false);
  });

  it("needs a name and a definition object to create", () => {
    const parse = (input: object) =>
      createMockServerOperation.inputSchema.safeParse(input).success;
    expect(parse({ name: "m", definition: {} })).toBe(true);
    expect(parse({ definition: {} })).toBe(false);
    expect(parse({ name: "m" })).toBe(false);
    expect(parse({ name: "m", definition: [] })).toBe(false);
  });

  it("declares writes with no spend, behind climbs, and a read that stays open", () => {
    for (const op of [createMockServerOperation, updateMockServerOperation]) {
      expect(op.readOnly).toBe(false);
      expect(op.risk).toBe("none");
      expect(OPERATION_FEATURES[op.name]).toBe("climbs");
      expect(isOperationAvailable(op.name, {})).toBe(false);
      expect(isOperationAvailable(op.name, { climbs: true })).toBe(true);
    }
    expect(getMockServerOperation.readOnly).toBe(true);
    expect(isOperationAvailable("get_mock_server", {})).toBe(true);
  });
});
