import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  diffServerRevisionsOperation,
  getServerRevisionOperation,
  listServerRevisionsOperation,
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

// A stdio server: live operations refuse it, but its stored revisions are
// readable like any other server's.
const SERVER = {
  id: "server-1",
  name: "markets",
  projectId: PROJECT.id,
  transportType: "stdio",
  url: null,
};

const SUMMARY = {
  revisionNumber: 2,
  capturedAt: 10,
  source: "connect",
  sourceId: null,
  counts: { tools: 2 },
};

/** A client whose API answers from `routes`, recording every request. */
function clientWith(routes: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    if (key.endsWith("/servers")) return Response.json({ items: [SERVER] });
    if (key in routes) return Response.json(routes[key]);
    throw new Error(`unexpected ${key}`);
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  const lastUrl = () => new URL(String(fetchMock.mock.calls.at(-1)?.[0]));
  return { client, lastUrl };
}

const CONTEXT = { signal: new AbortController().signal };
const REVISIONS = "GET /api/v1/projects/project-1/servers/server-1/revisions";

describe("server revision operations", () => {
  it("lists a stdio server's revisions by name, forwarding the page", async () => {
    const { client, lastUrl } = clientWith({
      [REVISIONS]: { items: [SUMMARY], nextCursor: "2" },
    });

    const result = await listServerRevisionsOperation.execute(
      { server: "markets", limit: 1, cursor: "3" },
      { client, ...CONTEXT }
    );

    expect(result).toEqual({
      project: expect.objectContaining({ id: "project-1" }),
      server: { id: "server-1", name: "markets" },
      items: [SUMMARY],
      nextCursor: "2",
    });
    expect(lastUrl().searchParams.get("limit")).toBe("1");
    expect(lastUrl().searchParams.get("cursor")).toBe("3");
  });

  it("reads one revision by number", async () => {
    const revision = {
      ...SUMMARY,
      tools: [{ name: "list_markets" }],
      discovery: null,
      captureError: null,
      droppedFields: [],
    };
    const { client } = clientWith({ [`${REVISIONS}/2`]: revision });

    const result = await getServerRevisionOperation.execute(
      { server: "server-1", revisionNumber: 2 },
      { client, ...CONTEXT }
    );

    expect(result.revision).toEqual(revision);
  });

  it("diffs against the previous revision unless told where to start", async () => {
    const diff = {
      from: { ...SUMMARY, revisionNumber: 1 },
      to: SUMMARY,
      tools: { added: [], removed: [], changed: [] },
      discovery: [
        { field: "serverInfo.version", before: "4.1.2", after: "1.7.0" },
      ],
      droppedFields: { from: [], to: [] },
    };
    const { client, lastUrl } = clientWith({ [`${REVISIONS}/2/diff`]: diff });

    const latest = await diffServerRevisionsOperation.execute(
      { server: "markets", revisionNumber: 2 },
      { client, ...CONTEXT }
    );
    expect(latest.diff).toEqual(diff);
    expect(lastUrl().searchParams.has("from")).toBe(false);

    await diffServerRevisionsOperation.execute(
      { server: "markets", revisionNumber: 2, fromRevisionNumber: 1 },
      { client, ...CONTEXT }
    );
    expect(lastUrl().searchParams.get("from")).toBe("1");
  });

  it("rejects a revision number below 1 before calling the API", () => {
    expect(
      getServerRevisionOperation.inputSchema.safeParse({
        server: "markets",
        revisionNumber: 0,
      }).success
    ).toBe(false);
  });
});
