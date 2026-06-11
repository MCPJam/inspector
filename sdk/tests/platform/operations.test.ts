import { describe, expect, it, vi } from "vitest";
import {
  listProjectServersOperation,
  listProjectsOperation,
  PlatformApiClient,
  PlatformApiError,
  showServersOperation,
} from "../../src/platform/index.js";

const PROJECTS = [
  {
    id: "project-old",
    name: "Old",
    description: null,
    icon: null,
    organizationId: "org-a",
    visibility: null,
    createdAt: 1,
    updatedAt: 100,
  },
  {
    id: "project-new",
    name: "New",
    description: null,
    icon: null,
    organizationId: "org-a",
    visibility: null,
    createdAt: 2,
    updatedAt: 200,
  },
];

const SERVERS = [
  {
    id: "server-1",
    projectId: "project-new",
    name: "Docs",
    enabled: true,
    transportType: "stdio",
    url: null,
    useOAuth: false,
    hasClientSecret: false,
    createdAt: null,
    updatedAt: null,
  },
];

function makeClient(): { client: PlatformApiClient; fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn(async (target: unknown) => {
    const url = new URL(String(target));
    if (url.pathname === "/api/v1/projects") {
      return Response.json({ items: PROJECTS });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/servers$/.test(url.pathname)) {
      return Response.json({ items: SERVERS });
    }
    return Response.json(
      { code: "NOT_FOUND", message: `No route for ${url.pathname}` },
      { status: 404 }
    );
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.example.com/api/v1",
    getAuth: () => "sk_test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

describe("listProjectsOperation", () => {
  it("parses empty input and returns projects most recently updated first", async () => {
    const { client } = makeClient();
    const input = listProjectsOperation.inputSchema.parse({});

    const result = await listProjectsOperation.execute(input, { client });

    expect(result.items.map((project) => project.id)).toEqual([
      "project-new",
      "project-old",
    ]);
  });
});

describe("listProjectServersOperation", () => {
  it("resolves the project by name and returns servers with other projects", async () => {
    const { client, fetchMock } = makeClient();

    const result = await listProjectServersOperation.execute(
      { project: "new" },
      { client }
    );

    expect(result.project).toEqual({
      id: "project-new",
      name: "New",
      organizationId: "org-a",
    });
    expect(result.items).toEqual(SERVERS);
    expect(result.otherProjects).toEqual([{ id: "project-old", name: "Old" }]);
    const serverListCall = fetchMock.mock.calls.find(([target]) =>
      String(target).includes("/servers")
    );
    expect(String(serverListCall?.[0])).toContain("/projects/project-new/servers");
  });

  it("throws an actionable PlatformApiError for unknown projects", async () => {
    const { client } = makeClient();

    const error = await listProjectServersOperation
      .execute({ project: "missing" }, { client })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).code).toBe("NOT_FOUND");
    expect((error as PlatformApiError).message).toContain("Available projects");
  });
});

describe("showServersOperation", () => {
  it("assembles a payload without doctor calls for skip-only projects", async () => {
    const { client, fetchMock } = makeClient();

    const payload = await showServersOperation.execute({}, { client });

    expect(payload.project.id).toBe("project-new");
    expect(payload.servers).toEqual([
      expect.objectContaining({ id: "server-1", status: "skipped" }),
    ]);
    expect(payload.summary.skipped).toBe(1);
    // stdio server short-circuits before any doctor POST.
    const doctorCalls = fetchMock.mock.calls.filter(([target]) =>
      String(target).includes("/doctor")
    );
    expect(doctorCalls).toHaveLength(0);
  });

  it("validates input schemas consistently across operations", () => {
    for (const operation of [
      listProjectsOperation,
      listProjectServersOperation,
      showServersOperation,
    ]) {
      expect(operation.name).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
      expect(operation.inputSchema.safeParse({}).success).toBe(true);
    }
    expect(
      showServersOperation.inputSchema.safeParse({ project: "" }).success
    ).toBe(false);
  });
});
