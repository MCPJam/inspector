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
