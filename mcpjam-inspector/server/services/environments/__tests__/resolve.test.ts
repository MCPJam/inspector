import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  environmentEffectiveServerIds,
  environmentLaunchConflictError,
  environmentLaunchRejectionError,
  environmentServerIds,
  environmentServerNames,
  isEnvironmentLaunchConflict,
  resolveEnvironmentForLaunch,
  type ResolvedEnvironmentForLaunch,
} from "../resolve";
import { WebRouteError } from "../../../routes/web/errors";

const RESOLVED: ResolvedEnvironmentForLaunch = {
  environmentRef: { environmentId: "env-1", name: "Staging", revision: 4 },
  hostId: "host-1",
  hostName: "Alpha",
  hostConfigId: "hc_1",
  selectedServerIds: ["ps_1", "ps_2"],
  effectiveServerIds: ["ps_1", "ps_2"],
  pluginVersions: [],
  servers: [
    { serverId: "ps_1", name: "linear" },
    { serverId: "ps_2", name: "asana" },
  ],
};

/** A resolution whose environment pins a plugin that contributes a server. */
const RESOLVED_WITH_PLUGIN: ResolvedEnvironmentForLaunch = {
  ...RESOLVED,
  selectedServerIds: ["ps_1"],
  effectiveServerIds: ["ps_1", "ps_plugin"],
  pluginVersions: [
    {
      pluginId: "pl_1",
      pluginVersionId: "pv_1",
      name: "linear",
      bundleHash: "abc123",
    },
  ],
  servers: [
    { serverId: "ps_1", name: "linear" },
    { serverId: "ps_plugin", name: "linear-plugin" },
  ],
};

function fakeConvexClient(result: unknown) {
  return {
    query: async () => result,
  } as unknown as Parameters<typeof resolveEnvironmentForLaunch>[0];
}

describe("environmentServerIds", () => {
  it("prefers the live-healed server ids (manager keys by id, not name)", () => {
    expect(environmentServerIds(RESOLVED)).toEqual(["ps_1", "ps_2"]);
  });

  it("returns the healed id when a server was deleted and re-added (id != raw)", () => {
    expect(
      environmentServerIds({
        ...RESOLVED,
        selectedServerIds: ["ps_stale"],
        servers: [{ serverId: "ps_live", name: "linear" }],
      })
    ).toEqual(["ps_live"]);
  });

  it("keeps a PRESENT-but-empty healed projection empty", () => {
    // `[]` is a real answer — every stored edge was genuinely removed during
    // live healing. Falling back here would resurrect the stored ids and
    // connect servers the environment no longer resolves to.
    expect(environmentServerIds({ ...RESOLVED, servers: [] })).toEqual([]);
  });

  it("falls back to effectiveServerIds when the projection is ABSENT (deploy skew)", () => {
    // An older backend omits `servers` entirely. The fallback must prefer the
    // effective set — `selectedServerIds` excludes plugin-contributed servers.
    expect(
      environmentServerIds({
        ...RESOLVED_WITH_PLUGIN,
        servers: undefined,
      })
    ).toEqual(["ps_1", "ps_plugin"]);
  });

  it("falls back to selectedServerIds only when effectiveServerIds is also absent", () => {
    expect(
      environmentServerIds({
        ...RESOLVED,
        effectiveServerIds: undefined,
        servers: undefined,
      })
    ).toEqual(["ps_1", "ps_2"]);
  });
});

describe("environmentServerNames", () => {
  it("projects display names aligned with the healed ids", () => {
    expect(environmentServerNames(RESOLVED)).toEqual(["linear", "asana"]);
  });

  it("is empty when the healed projection is absent or present-but-empty", () => {
    expect(
      environmentServerNames({
        ...RESOLVED,
        servers: undefined,
      })
    ).toEqual([]);
    expect(environmentServerNames({ ...RESOLVED, servers: [] })).toEqual([]);
  });
});

describe("environmentEffectiveServerIds", () => {
  it("echoes the STORED effective set, including plugin-contributed servers", () => {
    expect(environmentEffectiveServerIds(RESOLVED_WITH_PLUGIN)).toEqual([
      "ps_1",
      "ps_plugin",
    ]);
  });

  it("is the stored set, never the live-healed projection", () => {
    // The backend re-derives the STORED set to compare, so echoing healed ids
    // would read as drift for any server that had been delete-and-re-added.
    const healed: ResolvedEnvironmentForLaunch = {
      ...RESOLVED,
      effectiveServerIds: ["ps_stale"],
      servers: [{ serverId: "ps_live", name: "linear" }],
    };
    expect(environmentEffectiveServerIds(healed)).toEqual(["ps_stale"]);
  });

  it("falls back to the non-plugin closed set on deploy skew", () => {
    expect(
      environmentEffectiveServerIds({
        ...RESOLVED,
        effectiveServerIds: undefined,
      })
    ).toEqual(["ps_1", "ps_2"]);
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

  it("parses the newer backend fields (effectiveServerIds, pluginVersions)", async () => {
    const resolved = await resolveEnvironmentForLaunch(
      fakeConvexClient(RESOLVED_WITH_PLUGIN),
      { projectId: "p_1", environmentId: "env-1" }
    );
    expect(resolved.effectiveServerIds).toEqual(["ps_1", "ps_plugin"]);
    expect(resolved.pluginVersions).toEqual([
      {
        pluginId: "pl_1",
        pluginVersionId: "pv_1",
        name: "linear",
        bundleHash: "abc123",
      },
    ]);
    expect(resolved.hostConfigId).toBe("hc_1");
  });

  it("still parses an older backend that omits the newer fields", async () => {
    const legacy = {
      environmentRef: { environmentId: "env-1", name: "Staging", revision: 4 },
      hostId: "host-1",
      selectedServerIds: ["ps_1"],
      servers: [{ serverId: "ps_1", name: "linear" }],
    };
    const resolved = await resolveEnvironmentForLaunch(
      fakeConvexClient(legacy),
      { projectId: "p_1", environmentId: "env-1" }
    );
    expect(resolved.effectiveServerIds).toBeUndefined();
    expect(environmentEffectiveServerIds(resolved)).toEqual(["ps_1"]);
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

describe("isEnvironmentLaunchConflict", () => {
  it("matches the structured ConvexError codes for BOTH preconditions", () => {
    expect(
      isEnvironmentLaunchConflict(
        new ConvexError({ code: "ENV_REVISION_CONFLICT", expected: 3 })
      )
    ).toBe(true);
    // Drift: the environment is unchanged but what it points at moved.
    expect(
      isEnvironmentLaunchConflict(new ConvexError({ code: "ENV_HOST_DRIFT" }))
    ).toBe(true);
    expect(
      isEnvironmentLaunchConflict(new ConvexError({ code: "CONFLICT" }))
    ).toBe(true);
  });

  it("falls back to a message probe, but never matches unrelated errors", () => {
    expect(
      isEnvironmentLaunchConflict(
        new Error("environment revision conflict: expected 3, found 4")
      )
    ).toBe(true);
    expect(
      isEnvironmentLaunchConflict(new Error("environment host drift detected"))
    ).toBe(true);
    expect(isEnvironmentLaunchConflict(new Error("quota exceeded"))).toBe(
      false
    );
    expect(isEnvironmentLaunchConflict(new Error("revision conflict"))).toBe(
      false
    );
  });
});

describe("environmentLaunchConflictError", () => {
  it("shapes the interactive 409 with the retry copy", () => {
    const err = environmentLaunchConflictError();
    expect(err).toBeInstanceOf(WebRouteError);
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/Environment changed — retry the run/);
  });

  it("names the actual cause for drift, since the user's fix differs", () => {
    // "Reload the environment" would mislead: the environment is unchanged —
    // its host config rotated, or the pinned server group was edited.
    const err = environmentLaunchConflictError(
      new ConvexError({ code: "ENV_HOST_DRIFT" })
    );
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/host or server group changed/i);
  });
});

describe("environmentLaunchRejectionError", () => {
  it("forwards a structured launch refusal as the caller's 400, not a 500", () => {
    // The whole point of the backend raising ConvexError for these: Convex
    // redacts a plain Error's message in production, so an untranslated throw
    // reaches the caller as "Server Error" and they cannot tell a bad request
    // from a broken server.
    const err = environmentLaunchRejectionError(
      new ConvexError({
        code: "VALIDATION",
        message:
          "ephemeralEnvironment requires environmentId — it names the environment to run without attaching it.",
      })
    )!;
    expect(err).toBeInstanceOf(WebRouteError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/requires environmentId/i);
    expect((err.details as Record<string, unknown>).reason).toBe("validation");
  });

  it("makes cross-project and missing INDISTINGUISHABLE, not merely both 404", () => {
    // Deliberately distinct backend messages: if either reached the caller,
    // submitting an arbitrary id would reveal which project it lives in — the
    // enumeration answering 404 exists to prevent. A shared status with a
    // differing body collapses nothing, so the whole payload is compared.
    const crossProject = environmentLaunchRejectionError(
      new ConvexError({
        code: "ENV_CROSS_PROJECT",
        message: "Environment belongs to a different project.",
        details: { environmentId: "env_someone_elses" },
      })
    )!;
    const missing = environmentLaunchRejectionError(
      new ConvexError({
        code: "ENV_NOT_FOUND",
        message: "Environment not found.",
        details: { environmentId: "env_never_existed" },
      })
    )!;

    for (const err of [crossProject, missing]) {
      expect(err.status).toBe(404);
    }
    expect(crossProject.message).toBe(missing.message);
    expect(crossProject.details).toEqual(missing.details);
    // And neither leaks the backend's wording or the originating code.
    expect(JSON.stringify(crossProject)).not.toMatch(/different project/i);
    expect(JSON.stringify(crossProject)).not.toMatch(/CROSS_PROJECT/);
  });

  it("keeps a non-member or ambiguous selection a 400 the caller can act on", () => {
    for (const code of ["ENV_NOT_A_MEMBER", "ENV_AMBIGUOUS", "ENV_ARCHIVED"]) {
      const err = environmentLaunchRejectionError(
        new ConvexError({ code, message: "nope" })
      )!;
      expect(err.status).toBe(400);
      expect((err.details as Record<string, unknown>).code).toBe(code);
    }
  });

  it("returns null for anything unrecognized so a real fault stays a logged 500", () => {
    expect(
      environmentLaunchRejectionError(new ConvexError({ code: "SOMETHING_NEW" }))
    ).toBeNull();
    expect(environmentLaunchRejectionError(new Error("boom"))).toBeNull();
    expect(environmentLaunchRejectionError(null)).toBeNull();
  });

  it("returns null for structured payloads carrying no usable code", () => {
    // These reach the guards rather than the code lookup, and each is a shape
    // a backend can actually produce. Falling through to a 500 is right: we
    // cannot name a reason we were not given.
    expect(environmentLaunchRejectionError({ data: {} })).toBeNull();
    expect(environmentLaunchRejectionError({ data: { code: "" } })).toBeNull();
    expect(environmentLaunchRejectionError({ data: { code: 42 } })).toBeNull();
    expect(environmentLaunchRejectionError({ data: [] })).toBeNull();
    expect(environmentLaunchRejectionError({ data: null })).toBeNull();
  });
});
