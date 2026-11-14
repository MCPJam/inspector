import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  getConformanceCheckOperation,
  getConformanceReportOperation,
  listConformanceRunsOperation,
  startConformanceRunOperation,
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

const SERVER = {
  id: "server-1",
  name: "payments",
  projectId: PROJECT.id,
  transportType: "http",
  url: "https://payments.example.test/mcp",
};

/** A client whose API answers from `routes`, recording every request. */
function clientWith(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) {
      return Response.json({ items: [PROJECT] });
    }
    if (key.endsWith("/servers")) return Response.json({ items: [SERVER] });
    if (key in routes) return Response.json(routes[key]);
    throw new Error(`unexpected ${key}`);
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  const requested = () =>
    fetchMock.mock.calls.map(([input, init]) => ({
      url: new URL(String(input)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }));
  return { client, requested };
}

const CONTEXT = { signal: new AbortController().signal };

describe("conformance operations", () => {
  it("starts a run on a server named in the project, asking for its saved settings", async () => {
    const { client, requested } = clientWith({
      "POST /api/v1/projects/project-1/servers/server-1/conformance-runs": {
        runId: "run-1",
        projectId: PROJECT.id,
        serverId: SERVER.id,
        status: "queued",
        deduped: false,
        requestedSuites: ["protocol"],
        settingsSource: "saved",
      },
    });
    const result = await startConformanceRunOperation.execute(
      { server: "payments", settings: "saved" },
      { client, ...CONTEXT }
    );
    expect(result.run).toMatchObject({
      runId: "run-1",
      settingsSource: "saved",
    });
    expect(requested().at(-1)?.body).toEqual({ settings: "saved" });
  });

  it("pages run history with the API's cursor", async () => {
    const { client, requested } = clientWith({
      "GET /api/v1/projects/project-1/conformance-runs": {
        items: [{ id: "run-2" }],
        nextCursor: "page-3",
      },
    });
    const result = await listConformanceRunsOperation.execute(
      { cursor: "page-2" },
      { client, ...CONTEXT }
    );
    expect(result).toMatchObject({ nextCursor: "page-3" });
    expect(requested().at(-1)?.url.searchParams.get("cursor")).toBe("page-2");
  });

  it("pages a run's failing checks with the report's cursor", async () => {
    const { client, requested } = clientWith({
      "GET /api/v1/projects/project-1/conformance-runs/run-1/report": {
        runId: "run-1",
        checks: [{ suiteKind: "protocol", id: "wire-schema-valid" }],
        nextCursor: "c2",
      },
    });
    const result = await getConformanceReportOperation.execute(
      { run: "run-1", cursor: "c1" },
      { client, ...CONTEXT }
    );
    expect(result).toMatchObject({ runId: "run-1", nextCursor: "c2" });
    expect(requested().at(-1)?.url.searchParams.get("cursor")).toBe("c1");
  });

  it("reads one check, naming its suite only when asked to", async () => {
    const { client, requested } = clientWith({
      "GET /api/v1/projects/project-1/conformance-runs/run-1/checks/wire%20schema":
        {
          runId: "run-1",
          suiteKind: "tasks",
          id: "wire schema",
          status: "failed",
          truncated: { details: false, output: false },
        },
    });
    const result = await getConformanceCheckOperation.execute(
      { run: "run-1", check: "wire schema", suite: "tasks" },
      { client, ...CONTEXT }
    );
    expect(result).toMatchObject({
      project: { id: PROJECT.id },
      suiteKind: "tasks",
      status: "failed",
    });
    expect(requested().at(-1)?.url.searchParams.get("suite")).toBe("tasks");
  });
});
