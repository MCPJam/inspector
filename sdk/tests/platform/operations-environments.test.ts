import { describe, expect, it, vi } from "vitest";
import {
  archiveEnvironmentOperation,
  getEnvironmentOperation,
  PlatformApiClient,
  PlatformApiError,
  restoreEnvironmentOperation,
} from "../../src/platform/index.js";

// Name-based environment selectors, which are the only interesting part of the
// environment operations: archiving FREES the name, so a project can hold an
// archived "Staging" and a live "Staging" simultaneously and the selector has
// to pick the one the operation is actually for.

const PROJECT = {
  id: "project-1",
  name: "Acme",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 1,
};

function environment(
  id: string,
  name: string,
  archived: boolean
): Record<string, unknown> {
  return {
    id,
    projectId: PROJECT.id,
    name,
    hostId: "host-1",
    revision: 4,
    archived,
    ...(archived ? { archivedAt: 10 } : {}),
    createdAt: 1,
    updatedAt: 2,
  };
}

function makeClient(environments: Array<Record<string, unknown>>): {
  client: PlatformApiClient;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  const fetchMock = vi.fn(async (target: unknown, init?: RequestInit) => {
    const url = new URL(String(target));
    const path = url.pathname;
    if (path === "/api/v1/projects") {
      return Response.json({ items: [PROJECT] });
    }
    if (/^\/api\/v1\/projects\/[^/]+\/environments$/.test(path)) {
      // The selector always asks for archived rows too — restore needs them.
      expect(url.searchParams.get("includeArchived")).toBe("true");
      return Response.json({ items: environments });
    }
    const detail = /^\/api\/v1\/projects\/[^/]+\/environments\/([^/]+)$/.exec(
      path
    );
    if (detail) {
      return Response.json(
        environments.find((env) => env.id === decodeURIComponent(detail[1]!))
      );
    }
    const restore =
      /^\/api\/v1\/projects\/[^/]+\/environments\/([^/]+)\/restore$/.exec(path);
    if (restore) {
      expect(init?.method).toBe("POST");
      return Response.json({
        ...environment(decodeURIComponent(restore[1]!), "Staging", false),
        revision: 5,
      });
    }
    const archive =
      /^\/api\/v1\/projects\/[^/]+\/environments\/([^/]+)\/archive$/.exec(path);
    if (archive) {
      expect(init?.method).toBe("POST");
      return Response.json({
        ...environment(decodeURIComponent(archive[1]!), "Staging", true),
        revision: 5,
      });
    }
    return Response.json(
      { code: "NOT_FOUND", message: `No route for ${path}` },
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

const LIVE_AND_ARCHIVED = [
  environment("env-archived", "Staging", true),
  environment("env-live", "Staging", false),
];

describe("environment selector resolution", () => {
  it("prefers the live environment when an archived one shares the name", async () => {
    const { client } = makeClient(LIVE_AND_ARCHIVED);

    const result = await getEnvironmentOperation.execute(
      { environment: "staging" },
      { client }
    );

    expect(result.id).toBe("env-live");
  });

  it("keeps a mutation on the live environment too", async () => {
    const { client, fetchMock } = makeClient(LIVE_AND_ARCHIVED);

    await archiveEnvironmentOperation.execute(
      { environment: "Staging", expectedRevision: 4 },
      { client }
    );

    expect(
      fetchMock.mock.calls.some(([target]) =>
        String(target).includes("/environments/env-live/archive")
      )
    ).toBe(true);
  });

  it("resolves restore against the archived environment", async () => {
    const { client, fetchMock } = makeClient(LIVE_AND_ARCHIVED);

    await restoreEnvironmentOperation.execute(
      { environment: "Staging", expectedRevision: 4 },
      { client }
    );

    expect(
      fetchMock.mock.calls.some(([target]) =>
        String(target).includes("/environments/env-archived/restore")
      )
    ).toBe(true);
  });

  it("still finds an archived-only environment by name", async () => {
    const { client } = makeClient([
      environment("env-archived", "Staging", true),
    ]);

    const result = await getEnvironmentOperation.execute(
      { environment: "Staging" },
      { client }
    );

    expect(result.id).toBe("env-archived");
  });

  it("resolves an exact ID ahead of any name match", async () => {
    const { client } = makeClient(LIVE_AND_ARCHIVED);

    const result = await getEnvironmentOperation.execute(
      { environment: "env-archived" },
      { client }
    );

    expect(result.id).toBe("env-archived");
  });

  it("still reports ambiguity within the preferred side", async () => {
    const { client } = makeClient([
      environment("env-archived-1", "Staging", true),
      environment("env-archived-2", "Staging", true),
    ]);

    const error = await restoreEnvironmentOperation
      .execute({ environment: "Staging", expectedRevision: 4 }, { client })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).message).toContain("ambiguous");
  });
});

// The id fast-path exists so list-hidden ad-hoc cells can be named at all. It
// must stay an optimization: names never take it, and taking it can never end
// worse than not having taken it.
describe("id fast-path", () => {
  const ADHOC_ID = "mh7wcbj5k2p9x4v6r8t1n3q5s7d9f0g2";

  it("uses the detail route for an id-shaped selector", async () => {
    const { client, fetchMock } = makeClient([
      { ...environment(ADHOC_ID, "", false), name: null },
    ]);

    const result = await getEnvironmentOperation.execute(
      { environment: ADHOC_ID },
      { client }
    );

    // A list-hidden row resolves at all — the list route never returns it.
    expect(result.id).toBe(ADHOC_ID);
    expect(
      fetchMock.mock.calls.some(([target]) =>
        String(target).includes(`/environments/${ADHOC_ID}`)
      )
    ).toBe(true);
  });

  it.each(["staging-environment", "Claude_Code_Prod", "production-eval-env"])(
    "never sends the name %s to the detail route",
    async (name) => {
      const { client, fetchMock } = makeClient([
        environment("env-live", name, false),
      ]);

      const result = await getEnvironmentOperation.execute(
        { environment: name },
        { client }
      );

      // Names reach `v.id()` as garbage and fail validation BEFORE the
      // handler, which the route reports as a 500 — so they must never be
      // spelled as ids in the first place.
      expect(result.id).toBe("env-live");
      expect(
        fetchMock.mock.calls.every(
          ([target]) => !String(target).includes(`/environments/${name}`)
        )
      ).toBe(true);
    }
  );

  it("falls back to the list when the detail route fails outright", async () => {
    const { client, fetchMock } = makeClient([
      environment(ADHOC_ID, "Staging", false),
    ]);
    const listRoutes = fetchMock.getMockImplementation()!;
    // Only the FAST PATH fails; the operation's own later read is fine. That
    // is the shape of the bug this guards: a detail-route failure during
    // resolution used to propagate instead of deferring to the list.
    let detailCalls = 0;
    fetchMock.mockImplementation(
      async (target: unknown, init?: RequestInit) => {
        const path = new URL(String(target)).pathname;
        if (/\/environments\/[^/]+$/.test(path) && detailCalls++ === 0) {
          return Response.json(
            { code: "INTERNAL_ERROR", message: "boom" },
            { status: 500 }
          );
        }
        return listRoutes(target, init);
      }
    );

    const result = await getEnvironmentOperation.execute(
      { environment: ADHOC_ID },
      { client }
    );

    // A 500 on the optimization must not surface when the list can answer.
    expect(result.id).toBe(ADHOC_ID);
  });
});
