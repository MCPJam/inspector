import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_PLUGINS_TIMEOUT_MS,
  activePluginNotice,
  activePluginServerGroups,
  dropActivePlugins,
  parseActivePluginsResponse,
  planActivePluginTurn,
  readActivePlugins,
  type ActivePluginsResult,
} from "../active-plugins.js";

type RawPlugin = {
  pluginId: string;
  status: "active" | "skipped";
  reason?: string;
  servers?: string[];
  skills?: string[];
};

/** A contract-shaped response built from a compact plugin list. */
function raw(plugins: RawPlugin[]) {
  const active = plugins.filter((plugin) => plugin.status === "active");
  const versions = active.map((plugin) => ({
    pluginId: plugin.pluginId,
    pluginVersionId: `pv_${plugin.pluginId}`,
    name: plugin.pluginId,
    bundleHash: `hash_${plugin.pluginId}`,
  }));
  const serverIds = active.flatMap((plugin) => plugin.servers ?? []);
  return {
    enabled: true,
    pluginVersions: versions,
    servers: {
      selectedServerIds: [],
      pluginServerIds: serverIds,
      baseEffectiveServerIds: serverIds,
      effectiveServerIds: serverIds,
      connectable: serverIds.map((serverId) => ({
        serverId,
        name: `name-${serverId}`,
        source: "plugin",
      })),
    },
    skills: active.flatMap((plugin) =>
      (plugin.skills ?? []).map((skillId) => ({
        skillId,
        name: skillId,
        description: `${skillId} description`,
        content: `${skillId} body`,
        aggregateHash: `agg_${skillId}`,
        channels: ["plugin"],
        files: [{ path: "a.md", size: 1, url: `https://signed/${skillId}` }],
      })),
    ),
    serverSkills: [],
    attribution: {
      pluginVersions: versions,
      effectiveServerIds: serverIds,
      serverComponents: active.flatMap((plugin) =>
        (plugin.servers ?? []).map((serverId) => ({
          pluginVersionId: `pv_${plugin.pluginId}`,
          componentKey: serverId,
          placement: "remote",
          authenticationPolicy: "on_use",
          materializedServerId: serverId,
        })),
      ),
      pluginSkills: active.flatMap((plugin) =>
        (plugin.skills ?? []).map((skillId) => ({
          pluginVersionId: `pv_${plugin.pluginId}`,
          modelRef: `${plugin.pluginId}/${skillId}`,
          materializedSkillId: skillId,
        })),
      ),
      unavailableComponents: [],
    },
    plugins: plugins.map((plugin) => ({
      pluginId: plugin.pluginId,
      pluginVersionId: `pv_${plugin.pluginId}`,
      name: plugin.pluginId,
      displayName: null,
      status: plugin.status,
      ...(plugin.reason ? { reason: plugin.reason } : {}),
      servers: (plugin.servers ?? []).map((serverId) => ({
        serverId,
        name: `name-${serverId}`,
        componentKey: serverId,
        placement: "remote",
      })),
      skills: (plugin.skills ?? []).map((skillId) => ({
        skillId,
        modelRef: `${plugin.pluginId}/${skillId}`,
        name: skillId,
        description: "",
      })),
    })),
  };
}

function parsed(plugins: RawPlugin[]): ActivePluginsResult {
  const read = parseActivePluginsResponse(raw(plugins));
  if (read.status !== "ok") throw new Error("fixture did not parse");
  return read.result;
}

describe("parseActivePluginsResponse", () => {
  it("reads enabled:false as off, and a shape it cannot trust as unavailable", () => {
    expect(parseActivePluginsResponse({ enabled: false })).toEqual({
      status: "off",
    });
    expect(parseActivePluginsResponse(null).status).toBe("unavailable");
    expect(parseActivePluginsResponse({ enabled: true }).status).toBe(
      "unavailable",
    );
  });

  it("reads the contract shape", () => {
    const result = parsed([
      { pluginId: "a", status: "active", servers: ["s1"], skills: ["k1"] },
      {
        pluginId: "b",
        status: "skipped",
        reason: "needs_setup",
        servers: ["s2"],
      },
    ]);
    expect(result.connectable).toEqual([{ serverId: "s1", name: "name-s1" }]);
    expect(result.skills[0]).toMatchObject({
      skillId: "k1",
      content: "k1 body",
      channels: ["plugin"],
      files: [{ path: "a.md", size: 1, url: "https://signed/k1" }],
    });
    expect(
      result.plugins.map((plugin) => [plugin.pluginId, plugin.reason]),
    ).toEqual([
      ["a", undefined],
      ["b", "needs_setup"],
    ]);
  });
});

describe("readActivePlugins", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for bodies and signed URLs in the given venue", async () => {
    const query = vi.fn().mockResolvedValue({ enabled: false });
    await readActivePlugins({
      bearer: async () => "jwt",
      projectId: "project-1",
      runtimeVenue: "hosted",
      client: { query } as never,
    });
    expect(query).toHaveBeenCalledWith("plugins:resolveActivePlugins", {
      projectId: "project-1",
      runtimeVenue: "hosted",
      content: true,
    });
  });

  it("treats a backend without the function as off, and any other failure as unavailable", async () => {
    const missing = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Could not find public function for 'plugins:resolveActivePlugins'",
        ),
      );
    expect(
      await readActivePlugins({
        bearer: async () => "jwt",
        projectId: "p",
        runtimeVenue: "local",
        client: { query: missing } as never,
      }),
    ).toEqual({ status: "off" });

    const failing = vi.fn().mockRejectedValue(new Error("Server Error"));
    expect(
      await readActivePlugins({
        bearer: async () => "jwt",
        projectId: "p",
        runtimeVenue: "local",
        client: { query: failing } as never,
      }),
    ).toEqual({ status: "unavailable", error: "Server Error" });

    expect(
      await readActivePlugins({
        bearer: async () => {
          throw new Error("no delegated token");
        },
        projectId: "p",
        runtimeVenue: "local",
      }),
    ).toEqual({ status: "unavailable", error: "no delegated token" });
  });

  it("gives up after its deadline", async () => {
    vi.useFakeTimers();
    const pending = readActivePlugins({
      bearer: async () => "jwt",
      projectId: "p",
      runtimeVenue: "local",
      client: { query: () => new Promise(() => {}) } as never,
    });
    await vi.advanceTimersByTimeAsync(ACTIVE_PLUGINS_TIMEOUT_MS + 1);
    expect(await pending).toEqual({
      status: "unavailable",
      error: "active plugins read timed out",
    });
  });
});

describe("planActivePluginTurn", () => {
  it("is undefined for a project with no plugins", () => {
    expect(
      planActivePluginTurn({
        result: parsed([]),
        selectedServerIds: ["x"],
        selectedServerNames: ["X"],
      }),
    ).toBeUndefined();
  });

  it("strips every plugin server from the body, then appends the contributing ones with aligned names", () => {
    const turn = planActivePluginTurn({
      result: parsed([
        {
          pluginId: "a",
          status: "active",
          servers: ["s1", "s2"],
          skills: ["k1"],
        },
        {
          pluginId: "b",
          status: "skipped",
          reason: "needs_auth",
          servers: ["s3"],
        },
      ]),
      selectedServerIds: ["s3", "mine", "s1"],
      selectedServerNames: ["n3", "Mine", "n1"],
    })!;
    expect(turn.stripped).toBe(true);
    expect(turn.changesServers).toBe(true);
    expect(turn.serverIds).toEqual(["mine", "s1", "s2"]);
    expect(turn.serverNames).toEqual(["Mine", "name-s1", "name-s2"]);
    expect(turn.serverNames).toHaveLength(turn.serverIds.length);
    expect(turn.capabilities.pluginSkills.map((skill) => skill.ref)).toEqual([
      "a/k1",
    ]);
    expect(turn.skipped).toEqual([
      { pluginId: "b", name: "b", displayName: null, reason: "needs_auth" },
    ]);
  });

  it("keeps names aligned when the body sent none", () => {
    const turn = planActivePluginTurn({
      result: parsed([{ pluginId: "a", status: "active", servers: ["s1"] }]),
      selectedServerIds: ["mine"],
    })!;
    expect(turn.serverIds).toEqual(["mine", "s1"]);
    expect(turn.serverNames).toEqual(["mine", "name-s1"]);
  });

  it("never names a disabled plugin, and keeps unknown reasons out of the notice", () => {
    const turn = planActivePluginTurn({
      result: parsed([
        { pluginId: "off", status: "skipped", reason: "disabled" },
        { pluginId: "new", status: "skipped", reason: "some_future_reason" },
      ]),
      selectedServerIds: [],
    })!;
    expect(turn.skipped).toEqual([]);
    expect(turn.unknownSkipReasons).toEqual(["some_future_reason"]);
    expect(activePluginNotice(turn)).toBeUndefined();
  });

  it("leaves the selection alone when the plugins add only skills", () => {
    const turn = planActivePluginTurn({
      result: parsed([{ pluginId: "a", status: "active", skills: ["k1"] }]),
      selectedServerIds: ["mine"],
      selectedServerNames: ["Mine"],
    })!;
    expect(turn.changesServers).toBe(false);
    expect(turn.capabilities.pluginSkills).toHaveLength(1);
  });

  it("skips whole plugins that would pass the turn's server bound, in plugin order", () => {
    const turn = planActivePluginTurn({
      result: parsed([
        { pluginId: "a", status: "active", servers: ["a1", "a2"] },
        {
          pluginId: "b",
          status: "active",
          servers: ["b1", "b2"],
          skills: ["kb"],
        },
        { pluginId: "c", status: "active", servers: ["c1"] },
        { pluginId: "d", status: "active", skills: ["kd"] },
      ]),
      selectedServerIds: ["mine"],
      maxServerIds: 4,
    })!;
    expect(turn.contributing.map((plugin) => plugin.pluginId)).toEqual([
      "a",
      "c",
      "d",
    ]);
    expect(turn.serverIds).toEqual(["mine", "a1", "a2", "c1"]);
    // A skipped plugin leaves whole: its skill goes too.
    expect(turn.capabilities.pluginSkills.map((skill) => skill.ref)).toEqual([
      "d/kd",
    ]);
    expect(turn.skipped).toEqual([
      { pluginId: "b", name: "b", displayName: null, reason: "over_cap" },
    ]);
  });
});

describe("dropActivePlugins", () => {
  const result = parsed([
    { pluginId: "a", status: "active", servers: ["a1", "a2"], skills: ["ka"] },
    { pluginId: "b", status: "active", servers: ["b1"], skills: ["kb"] },
    { pluginId: "c", status: "active", servers: ["c1"] },
  ]);

  it("drops a plugin whole and names it connect_failed", () => {
    const turn = planActivePluginTurn({
      result,
      selectedServerIds: ["mine"],
      selectedServerNames: ["Mine"],
    })!;
    expect(activePluginServerGroups(turn)).toEqual([
      { key: "a", serverIds: ["a1", "a2"] },
      { key: "b", serverIds: ["b1"] },
      { key: "c", serverIds: ["c1"] },
    ]);
    const dropped = dropActivePlugins(turn, result, ["a"], "connect_failed");
    expect(dropped.serverIds).toEqual(["mine", "b1", "c1"]);
    expect(dropped.serverNames).toEqual(["Mine", "name-b1", "name-c1"]);
    expect(dropped.capabilities.pluginSkills.map((skill) => skill.ref)).toEqual(
      ["b/kb"],
    );
    expect(
      dropped.capabilities.pluginVersions.map((version) => version.pluginId),
    ).toEqual(["b", "c"]);
    expect(activePluginNotice(dropped)).toEqual({
      kind: "skipped",
      plugins: [
        {
          pluginId: "a",
          name: "a",
          displayName: null,
          reason: "connect_failed",
        },
      ],
    });
  });

  it("never admits a plugin that was over the bound, even when a drop frees room", () => {
    const turn = planActivePluginTurn({
      result,
      selectedServerIds: [],
      maxServerIds: 3,
    })!;
    expect(turn.contributing.map((plugin) => plugin.pluginId)).toEqual([
      "a",
      "b",
    ]);
    const dropped = dropActivePlugins(turn, result, ["a"], "connect_failed");
    expect(dropped.contributing.map((plugin) => plugin.pluginId)).toEqual([
      "b",
    ]);
    expect(dropped.skipped.map((skip) => [skip.pluginId, skip.reason])).toEqual(
      [
        ["c", "over_cap"],
        ["a", "connect_failed"],
      ],
    );
  });
});
