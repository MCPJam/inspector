import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  environmentRevisionConflictError,
  environmentServerRefs,
  isEnvironmentRevisionConflict,
  resolveEnvironmentForLaunch,
  type ResolvedEnvironmentForLaunch,
} from "../environment-launch";
import { WebRouteError } from "../../../routes/web/errors";

const RESOLVED: ResolvedEnvironmentForLaunch = {
  environmentRef: { environmentId: "env-1", name: "Staging", revision: 4 },
  hostId: "host-1",
  selectedServerIds: ["ps_1", "ps_2"],
  servers: [
    { serverId: "ps_1", name: "linear" },
    { serverId: "ps_2", name: "asana" },
  ],
};

function fakeConvexClient(result: unknown) {
  return {
    query: async () => result,
  } as unknown as Parameters<typeof resolveEnvironmentForLaunch>[0];
}

describe("environmentServerRefs", () => {
  it("prefers the live-healed server-name projection", () => {
    expect(environmentServerRefs(RESOLVED)).toEqual(["linear", "asana"]);
  });

  it("falls back to ids when the healed projection is absent or empty", () => {
    expect(
      environmentServerRefs({
        ...RESOLVED,
        servers: undefined as unknown as ResolvedEnvironmentForLaunch["servers"],
      })
    ).toEqual(["ps_1", "ps_2"]);
    expect(environmentServerRefs({ ...RESOLVED, servers: [] })).toEqual([
      "ps_1",
      "ps_2",
    ]);
  });
});

describe("resolveEnvironmentForLaunch", () => {
  it("returns the resolver's closed set untouched", async () => {
    const resolved = await resolveEnvironmentForLaunch(
      fakeConvexClient(RESOLVED),
      { projectId: "p_1", environmentId: "env-1" }
    );
    expect(resolved).toEqual(RESOLVED);
  });

  it("404s a null / malformed resolution instead of running server-less", async () => {
    for (const bad of [null, {}, { environmentRef: {} }]) {
      await expect(
        resolveEnvironmentForLaunch(fakeConvexClient(bad), {
          projectId: "p_1",
          environmentId: "env-1",
        })
      ).rejects.toMatchObject({ status: 404 });
    }
  });

  it("maps a missing backend function to a readable 400 (deploy-order skew)", async () => {
    const client = {
      query: async () => {
        throw new Error(
          "Could not find public function for 'projectEnvironments:resolveEnvironmentForLaunch'"
        );
      },
    } as unknown as Parameters<typeof resolveEnvironmentForLaunch>[0];
    await expect(
      resolveEnvironmentForLaunch(client, {
        projectId: "p_1",
        environmentId: "env-1",
      })
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("isEnvironmentRevisionConflict", () => {
  it("matches the structured ConvexError code", () => {
    expect(
      isEnvironmentRevisionConflict(
        new ConvexError({ code: "ENV_REVISION_CONFLICT", expected: 3 })
      )
    ).toBe(true);
    expect(
      isEnvironmentRevisionConflict(new ConvexError({ code: "CONFLICT" }))
    ).toBe(true);
  });

  it("falls back to a message probe, but never matches unrelated errors", () => {
    expect(
      isEnvironmentRevisionConflict(
        new Error("environment revision conflict: expected 3, found 4")
      )
    ).toBe(true);
    expect(isEnvironmentRevisionConflict(new Error("quota exceeded"))).toBe(
      false
    );
    expect(isEnvironmentRevisionConflict(new Error("revision conflict"))).toBe(
      false
    );
  });

  it("shapes the interactive 409 with the retry copy", () => {
    const err = environmentRevisionConflictError();
    expect(err).toBeInstanceOf(WebRouteError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/Environment changed — retry the run/);
  });
});
