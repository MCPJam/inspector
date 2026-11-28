import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeMockRunOperation,
  createMockServerOperation,
  getMockServerOperation,
  openMockRunOperation,
  patchMockServerOperation,
  refreshMockServerOperation,
  resetMockRunOperation,
  setMockForwardingPolicyOperation,
} from "@mcpjam/sdk/platform";
import { MOCK_TEXT_BUDGET, readMockView, type MockDefinition, type MockListing } from "@mcpjam/sdk/mocks";
import { runPlatformOperation } from "../src/tools/platformTools.js";
import type { PlatformToolContext } from "../src/server.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
};

const fixture = JSON.parse(
  readFileSync(new URL("../../sdk/tests/fixtures/mock-surfaces.json", import.meta.url), "utf8")
) as Record<string, any>;
const { project, base, mock } = fixture.ids as Record<string, string>;
const ROOT = `/api/v1/projects/${project}/mock-servers`;

const context: PlatformToolContext = {
  getBearerToken: async () => ({ ok: true, token: "user-jwt" }),
  runtimeEnv: {
    PLATFORM_API_URL: "https://staging.example.com/api/v1",
    MCPJAM_APP_ORIGIN: "https://staging.example.com",
  },
};

const PROJECT = {
  id: project,
  name: "Checkout",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};
const SERVERS = [
  { id: base, projectId: project, name: "markets", transportType: "http", url: "https://x.test/mcp" },
  { id: mock, projectId: project, name: "markets (mock)", transportType: "http", url: "https://mock.mcpjam.invalid/m" },
];

/** The API's project and server lists, plus `answer` for the mock routes. */
function stubApi(answer: (method: string, url: URL, body: unknown) => Response) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/projects")) return Response.json({ items: [PROJECT] });
      if (url.pathname.endsWith(`${project}/servers`)) return Response.json({ items: SERVERS });
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method, path: url.pathname, body });
      return answer(method, url, body);
    })
  );
  return requests;
}

async function call(operation: Parameters<typeof runPlatformOperation>[1], input: object): Promise<ToolResult> {
  return (await runPlatformOperation(context, operation, input)) as ToolResult;
}

// The tool adds the project and links to what it returns; the rest is the route's body.
const withoutProject = ({ project: _project, permalinks: _links, ...rest }: Record<string, any>) => rest;

afterEach(() => vi.unstubAllGlobals());

describe("mock tools return what REST answers", () => {
  it("create, read and patch match the shared fixture, in text and structured content", async () => {
    const requests = stubApi((method, url) => {
      if (method === "POST") return Response.json(fixture.created, { status: 201 });
      if (method === "PATCH") return Response.json(fixture.patched, { status: 201 });
      return Response.json(url.searchParams.has("path") ? fixture.value : fixture.summary);
    });
    const created = await call(createMockServerOperation, { name: "markets (mock)", server: "markets", definition: {} });
    expect(withoutProject(created.structuredContent!)).toEqual(fixture.created);
    const summary = await call(getMockServerOperation, { mock: "markets (mock)" });
    expect(withoutProject(summary.structuredContent!)).toEqual(fixture.summary);
    const value = await call(getMockServerOperation, { mock: "markets (mock)", family: "tools", name: "tool_001", path: "description" });
    expect(withoutProject(value.structuredContent!)).toEqual(fixture.value);
    expect(JSON.parse(value.content[0]!.text.slice(value.content[0]!.text.indexOf("{")))).toMatchObject({ value: "First." });
    const patched = await call(patchMockServerOperation, { mock: "markets (mock)", expectedVersion: 2, family: "tools", name: "tool_001", path: ["description"], value: "Second." });
    expect(withoutProject(patched.structuredContent!)).toEqual(fixture.patched);
    expect(requests.find((r) => r.method === "PATCH")?.body).toEqual({ expectedVersion: 2, family: "tools", name: "tool_001", path: ["description"], value: "Second." });
  });

  it("refresh previews, and the policy write goes to the workspace setting", async () => {
    const requests = stubApi((method, url) =>
      url.pathname.endsWith("/refresh")
        ? Response.json({ view: "refresh", applied: false })
        : Response.json({ forwarding: "allow", scope: "workspace", updatedAt: 1, projectId: project })
    );
    expect((await call(refreshMockServerOperation, { mock: "markets (mock)", expectedVersion: 2 })).isError).toBeUndefined();
    await call(setMockForwardingPolicyOperation, { forwarding: "allow" });
    expect(requests.map((r) => `${r.method} ${r.path.replace(ROOT, "")}`)).toEqual([
      `POST /${mock}/refresh`,
      `PUT /api/v1/projects/${project}/mock-forwarding-policy`,
    ]);
  });
});

describe("test runs", () => {
  it("open, reset and close match the shared fixture, and send the run's routes", async () => {
    const requests = stubApi((_method, url) =>
      Response.json(url.pathname.endsWith("/reset") ? fixture.reset : url.pathname.endsWith("/close") ? fixture.closed : fixture.run, {
        status: url.pathname.endsWith("/runs") ? 201 : 200,
      })
    );
    const opened = await call(openMockRunOperation, { mock: "markets (mock)", version: 2 });
    expect(withoutProject(opened.structuredContent!)).toEqual(fixture.run);
    const reset = await call(resetMockRunOperation, { mock: "markets (mock)", runId: "run-1", expectedEpoch: 1 });
    expect(withoutProject(reset.structuredContent!)).toEqual(fixture.reset);
    const closed = await call(closeMockRunOperation, { mock: "markets (mock)", runId: "run-1" });
    expect(withoutProject(closed.structuredContent!)).toEqual(fixture.closed);
    expect(requests.map((r) => [r.method, r.path.replace(ROOT, ""), r.body])).toEqual([
      ["POST", `/${mock}/runs`, { version: 2 }],
      ["POST", `/${mock}/runs/run-1/reset`, { expectedEpoch: 1 }],
      ["POST", `/${mock}/runs/run-1/close`, {}],
    ]);
  });
});

describe("the limit on open test runs", () => {
  it("open_mock_run answers a tool error that says to close a run or wait", async () => {
    const message = "You have 100 open test runs. Close one, or wait for one to expire; a run lasts 24 hours.";
    stubApi(() => Response.json({ code: "CONFLICT", message, details: { code: "MOCK_RUN_LIMIT", limit: 100 } }, { status: 409 }));
    const result = await call(openMockRunOperation, { mock: "markets (mock)" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("You have 100 open test runs. Close one, or wait for one to expire");
  });
});

describe("every response fits the text budget on a 202-tool mock", () => {
  const tools = Array.from({ length: 202 }, (_, i) => ({
    name: `tool_${String(i + 1).padStart(3, "0")}`,
    description: `Tool number ${i + 1}. ${"It does one thing well and says so at length. ".repeat(4)}`,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  }));
  const long = `${'say "x"\n tab\t 😀 '.repeat(8000)}end`;
  const definition: MockDefinition = {
    instructions: "Use the tools.",
    tools: { tool_001: { description: "First." }, tool_202: { description: long }, tool_150: { hidden: true } },
  };
  const listing = { tools } as unknown as MockListing;

  /** What the route answers: the SDK's reads with the route's envelope. */
  function route(url: URL): Response {
    const q = url.searchParams;
    const path = q.get("path") ? q.get("path")!.split(".") : undefined;
    const offsetOf = (cursor: string | null) => (cursor ? Number(cursor.replace("c", "")) : 0);
    const envelope = { id: mock, mockName: "markets (mock)", projectId: project, version: 2, headVersion: 2, contentHash: "h", listing: "saved" };
    const view = readMockView(
      { definition, listing },
      {
        family: (q.get("family") ?? undefined) as never,
        name: q.get("name") ?? undefined,
        path,
        search: q.get("search") ?? undefined,
      },
      { offset: offsetOf(q.get("cursor")), seal: (n) => `c${n}`, envelope }
    );
    return Response.json({ ...envelope, ...view });
  }

  it("pages the names, then reads the last tool's long description in chunks that join back", async () => {
    stubApi((_method, url) => route(url));
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(getMockServerOperation, { mock: "markets (mock)", family: "tools", ...(cursor && { cursor }) });
      expect(page.content[0]!.text.length).toBeLessThanOrEqual(MOCK_TEXT_BUDGET);
      expect(page.content[0]!.text).not.toContain("[truncated");
      const body = page.structuredContent as { entries: { name: string }[]; page: { nextCursor?: string } };
      names.push(...body.entries.map((e) => e.name));
      cursor = body.page.nextCursor;
    } while (cursor);
    expect(names).toHaveLength(202);

    let joined = "";
    cursor = undefined;
    do {
      const chunk = await call(getMockServerOperation, { mock: "markets (mock)", family: "tools", name: "tool_202", path: "description", ...(cursor && { cursor }) });
      expect(chunk.content[0]!.text.length).toBeLessThanOrEqual(MOCK_TEXT_BUDGET);
      expect(chunk.content[0]!.text).not.toContain("[truncated");
      const body = chunk.structuredContent as { value: string; page: { nextCursor?: string } };
      joined += body.value;
      cursor = body.page.nextCursor;
    } while (cursor);
    expect(joined).toBe(long);
  });

  it("reads an entry with a very long field without exceeding the budget", async () => {
    stubApi((_method, url) => route(url));
    const entry = await call(getMockServerOperation, { mock: "markets (mock)", family: "tools", name: "tool_202" });
    expect(entry.content[0]!.text.length).toBeLessThanOrEqual(MOCK_TEXT_BUDGET);
    expect(entry.content[0]!.text).not.toContain("[truncated");
    expect(JSON.stringify(entry.structuredContent)).toContain("$omitted");
  });
});
