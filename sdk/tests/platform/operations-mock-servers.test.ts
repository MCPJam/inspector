import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  OPERATION_FEATURES,
  PlatformApiClient,
  closeMockRunOperation,
  createMockServerOperation,
  getMockForwardingPolicyOperation,
  getMockServerOperation,
  openMockRunOperation,
  isOperationAvailable,
  patchMockServerOperation,
  resetMockRunOperation,
  refreshMockServerOperation,
  setMockForwardingPolicyOperation,
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
const REAL = { id: "server-1", name: "markets", projectId: PROJECT.id, transportType: "http", url: "https://x.test/mcp" };
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
  loosened: [],
};
const POLICY = { forwarding: "block", scope: "workspace", updatedAt: 5, projectId: PROJECT.id };

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
const signal = new AbortController().signal;
const run = <I, O>(op: { execute(i: I, c: never): Promise<O> }, input: I, client: PlatformApiClient) =>
  op.execute(input, { client, signal } as never);

describe("mock server operations", () => {
  it("create sends the saved server's id and the definition, and returns the address", async () => {
    const { client, bodies } = clientWith({ "POST /api/v1/projects/project-1/mock-servers": SAVED });
    const result = await run(createMockServerOperation, { name: "markets (mock)", server: "markets", definition: { tools: {} } }, client);
    expect(bodies).toEqual([{ name: "markets (mock)", serverId: "server-1", definition: { tools: {} } }]);
    expect(result).toMatchObject({ id: "mock-1", version: 1, address: SAVED.address, project: { id: "project-1" } });
  });

  it("create without a server makes a mock from nothing", async () => {
    const { client, bodies } = clientWith({ "POST /api/v1/projects/project-1/mock-servers": SAVED });
    await run(createMockServerOperation, { name: "n", definition: {} }, client);
    expect(bodies[0]).not.toHaveProperty("serverId");
  });

  it("update names the head it read and sends a patch", async () => {
    const { client, bodies } = clientWith({
      "POST /api/v1/projects/project-1/mock-servers/mock-1/versions": { ...SAVED, version: 4, created: true },
    });
    const result = await run(updateMockServerOperation, { mock: "markets (mock)", patch: { tools: { a: { hidden: true } } }, expectedVersion: 3 }, client);
    expect(bodies).toEqual([{ patch: { tools: { a: { hidden: true } } }, expectedVersion: 3 }]);
    expect(result.version).toBe(4);
  });

  it("update takes a whole definition or a patch, never both or neither", () => {
    const schema = updateMockServerOperation.inputSchema;
    expect(schema.safeParse({ mock: "markets (mock)", expectedVersion: 1 }).success).toBe(false);
    expect(schema.safeParse({ mock: "markets (mock)", expectedVersion: 1, patch: {}, definition: {} }).success).toBe(false);
    expect(schema.safeParse({ mock: "markets (mock)", expectedVersion: 1, definition: {} }).success).toBe(true);
  });

  it("get reads one version without a definition body", async () => {
    const read = { ...SAVED, view: "summary", headVersion: 2, policy: { forwarding: "allow", scope: "workspace", updatedAt: null }, counts: { changes: 1, tools: 1, prompts: 0, resources: 0, resourceTemplates: 0 }, changes: { items: [], page: { offset: 0, count: 0, total: 1, end: true } }, createdAt: 1 };
    const { client, lastUrl } = clientWith({ "GET /api/v1/projects/project-1/mock-servers/mock-1": read });
    const result = await run(getMockServerOperation, { mock: "markets (mock)", version: 1 }, client);
    expect(lastUrl().searchParams.get("version")).toBe("1");
    expect(result).toMatchObject({ headVersion: 2, counts: { changes: 1 } });
    expect(result).not.toHaveProperty("definition");
  });

  it("get sends its selectors, with a path that has a dotted key as a JSON list", async () => {
    const { client, lastUrl } = clientWith({ "GET /api/v1/projects/project-1/mock-servers/mock-1": { view: "value" } });
    await run(getMockServerOperation, { mock: "markets (mock)", family: "tools", name: "t", path: "description", cursor: "c", limit: 5 }, client);
    expect(Object.fromEntries(lastUrl().searchParams)).toEqual({ family: "tools", name: "t", path: "description", cursor: "c", limit: "5" });
    await run(getMockServerOperation, { mock: "markets (mock)", family: "tools", name: "t", path: ["a.b", "c"] }, client);
    expect(lastUrl().searchParams.get("path")).toBe('["a.b","c"]');
  });

  it("patch sends one path and the version it read, never the entry", async () => {
    const { client, bodies } = clientWith({
      "PATCH /api/v1/projects/project-1/mock-servers/mock-1": { ...SAVED, version: 5, path: ["tools", "t", "description"] },
    });
    const result = await run(patchMockServerOperation, { mock: "markets (mock)", expectedVersion: 4, family: "tools", name: "t", path: ["description"], value: "New." }, client);
    expect(bodies).toEqual([{ expectedVersion: 4, family: "tools", name: "t", path: ["description"], value: "New." }]);
    expect(result).toMatchObject({ version: 5, path: ["tools", "t", "description"] });
  });

  it("refresh previews unless told to apply", async () => {
    const { client, bodies } = clientWith({
      "POST /api/v1/projects/project-1/mock-servers/mock-1/refresh": { view: "refresh", applied: false },
    });
    await run(refreshMockServerOperation, { mock: "markets (mock)", expectedVersion: 2 }, client);
    await run(refreshMockServerOperation, { mock: "markets (mock)", expectedVersion: 2, apply: true }, client);
    expect(bodies).toEqual([{ expectedVersion: 2 }, { expectedVersion: 2, apply: true }]);
  });

  it("reads the workspace's policy, or a mock's", async () => {
    const { client, lastUrl } = clientWith({
      "GET /api/v1/projects/project-1/mock-forwarding-policy": POLICY,
      "GET /api/v1/projects/project-1/mock-servers/mock-1/forwarding-policy": { ...POLICY, mockId: "mock-1" },
    });
    expect(await run(getMockForwardingPolicyOperation, {}, client)).toMatchObject({ forwarding: "block" });
    expect(lastUrl().pathname).toBe("/api/v1/projects/project-1/mock-forwarding-policy");
    expect(await run(getMockForwardingPolicyOperation, { mock: "markets (mock)" }, client)).toMatchObject({ mockId: "mock-1" });
  });

  it("sets the policy with PUT", async () => {
    const { client, bodies } = clientWith({ "PUT /api/v1/projects/project-1/mock-forwarding-policy": POLICY });
    await run(setMockForwardingPolicyOperation, { forwarding: "block" }, client);
    expect(bodies).toEqual([{ forwarding: "block" }]);
    expect(setMockForwardingPolicyOperation.readOnly).toBe(false);
    expect(setMockForwardingPolicyOperation.risk).toBe("exposure");
  });

  it("are not hidden by an organization feature: the backend answers the flag", () => {
    for (const name of ["create_mock_server", "update_mock_server", "get_mock_server", "patch_mock_server", "refresh_mock_server", "get_mock_forwarding_policy", "set_mock_forwarding_policy"]) {
      expect(OPERATION_FEATURES[name]).toBeNull();
      expect(isOperationAvailable(name, {} as never)).toBe(true);
    }
  });
});

// The REST route answers these bodies (its own test pins them); every surface
// returns them unchanged, with the project the operation resolved.
describe("results match the shared surface fixture", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("../fixtures/mock-surfaces.json", import.meta.url), "utf8"),
  ) as Record<string, any>;
  const { project, base, mock } = fixture.ids as Record<string, string>;
  const root = `/api/v1/projects/${project}/mock-servers`;

  const runBodies: unknown[] = [];
  function stub() {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const key = `${init?.method ?? "GET"} ${url.pathname}`;
      if (key.endsWith("/projects")) return Response.json({ items: [{ ...PROJECT, id: project }] });
      if (key.endsWith("/servers")) {
        return Response.json({
          items: [
            { ...REAL, id: base, projectId: project },
            { ...MOCK, id: mock, projectId: project },
          ],
        });
      }
      if (key === `POST ${root}`) return Response.json(fixture.created, { status: 201 });
      if (key === `GET ${root}/${mock}`) return Response.json(url.searchParams.has("path") ? fixture.value : fixture.summary);
      if (key === `PATCH ${root}/${mock}`) return Response.json(fixture.patched, { status: 201 });
      if (key === `POST ${root}/${mock}/runs`) return Response.json(fixture.run, { status: 201 });
      if (key === `POST ${root}/${mock}/runs/run-1/reset`) {
        runBodies.push(JSON.parse(String(init?.body)));
        return Response.json(fixture.reset);
      }
      if (key === `POST ${root}/${mock}/runs/run-1/close`) return Response.json(fixture.closed);
      throw new Error(`unexpected ${key}`);
    });
    return new PlatformApiClient({ baseUrl: "https://api.test/api/v1", getAuth: () => "t", fetch: fetchMock as unknown as typeof fetch });
  }
  const withProject = (body: object) => ({ ...body, project: expect.objectContaining({ id: project }) });

  it("create, read and patch", async () => {
    const client = stub();
    expect(await run(createMockServerOperation, { name: "markets (mock)", server: "markets", definition: {} }, client)).toEqual(withProject(fixture.created));
    expect(await run(getMockServerOperation, { mock: "markets (mock)" }, client)).toEqual(withProject(fixture.summary));
    expect(await run(getMockServerOperation, { mock: "markets (mock)", family: "tools", name: "tool_001", path: "description" }, client)).toEqual(withProject(fixture.value));
    const patched = await run(patchMockServerOperation, { mock: "markets (mock)", expectedVersion: 2, family: "tools", name: "tool_001", path: ["description"], value: "Second." }, client);
    expect(patched).toEqual(withProject(fixture.patched));
  });

  it("open, reset and close a test run", async () => {
    const client = stub();
    expect(await run(openMockRunOperation, { mock: "markets (mock)" }, client)).toEqual(withProject(fixture.run));
    const reset = await run(resetMockRunOperation, { mock: "markets (mock)", runId: "run-1", expectedEpoch: 1 }, client);
    expect(reset).toEqual(withProject(fixture.reset));
    expect(runBodies).toEqual([{ expectedEpoch: 1 }]);
    expect(await run(closeMockRunOperation, { mock: "markets (mock)", runId: "run-1" }, client)).toEqual(withProject(fixture.closed));
  });
});
