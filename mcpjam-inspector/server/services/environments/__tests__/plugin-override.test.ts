import { describe, expect, it } from "vitest";
import { applyPluginVersionOverride } from "../plugin-override.js";
import type { PluginRuntimeAttribution } from "../plugin-attribution.js";
import type { ResolvedEnvironmentRuntime } from "../runtime.js";

function version(id: string, name: string) {
  return {
    pluginId: `plg_${name}`,
    pluginVersionId: id,
    name,
    bundleHash: `hash_${id}`,
  };
}

function skill(
  skillId: string,
  channels: Array<"host" | "environment" | "plugin">
) {
  return {
    skillId,
    name: skillId,
    description: "",
    content: "",
    aggregateHash: `hash_${skillId}`,
    channels,
  };
}

function spec(): ResolvedEnvironmentRuntime {
  return {
    environmentRef: { environmentId: "env_1", name: "Env", revision: 3 },
    host: { hostId: "host_1", runtimeConfig: { modelId: "m" } },
    servers: {
      baseEffectiveServerIds: ["srv_host", "srv_a", "srv_b"],
      effectiveServerIds: ["srv_host", "srv_a", "srv_b"],
      pluginServerIds: ["srv_a", "srv_b"],
      connectable: [
        { serverId: "srv_host", name: "linear", source: "host_or_group" },
        { serverId: "srv_a", name: "a-tools", source: "plugin" },
        { serverId: "srv_b", name: "b-tools", source: "plugin" },
      ],
    },
    skills: [
      skill("skl_a", ["plugin"]),
      skill("skl_b", ["plugin"]),
      skill("skl_env", ["environment"]),
    ],
    pluginVersions: [version("pv_a", "alpha"), version("pv_b", "beta")],
  };
}

function attribution(): PluginRuntimeAttribution {
  return {
    serverOrigins: new Map([
      ["srv_a", { ...version("pv_a", "alpha") }],
      ["srv_b", { ...version("pv_b", "beta") }],
    ]),
    skillOrigins: new Map([
      [
        "skl_a",
        { modelRef: "alpha/a-skill", plugin: version("pv_a", "alpha") },
      ],
      ["skl_b", { modelRef: "beta/b-skill", plugin: version("pv_b", "beta") }],
    ]),
    unattributedVersionIds: [],
  };
}

describe("applyPluginVersionOverride", () => {
  it("drops only the deselected version's servers, skills and pin", () => {
    const result = applyPluginVersionOverride({
      spec: spec(),
      attribution: attribution(),
      retainedVersionIds: ["pv_a"],
    });

    expect(result.droppedVersionIds).toEqual(["pv_b"]);
    expect(result.spec.servers.effectiveServerIds).toEqual([
      "srv_host",
      "srv_a",
    ]);
    expect(result.spec.servers.pluginServerIds).toEqual(["srv_a"]);
    expect(result.spec.servers.connectable?.map((s) => s.serverId)).toEqual([
      "srv_host",
      "srv_a",
    ]);
    expect(result.spec.skills?.map((s) => s.skillId)).toEqual([
      "skl_a",
      "skl_env",
    ]);
    expect(result.spec.pluginVersions?.map((p) => p.pluginVersionId)).toEqual([
      "pv_a",
    ]);
    // The environment's own base set is untouched — it is what "reset to the
    // environment" means, and what `runtimeServersAreOverridden` compares to.
    expect(result.spec.servers.baseEffectiveServerIds).toEqual([
      "srv_host",
      "srv_a",
      "srv_b",
    ]);
  });

  it("deselecting everything leaves the host's own servers running", () => {
    const result = applyPluginVersionOverride({
      spec: spec(),
      attribution: attribution(),
      retainedVersionIds: [],
    });
    expect(result.spec.servers.effectiveServerIds).toEqual(["srv_host"]);
    expect(result.spec.pluginVersions).toEqual([]);
    expect(result.droppedSkillIds.sort()).toEqual(["skl_a", "skl_b"]);
  });

  it("is a no-op when every pinned version is retained", () => {
    const input = spec();
    const result = applyPluginVersionOverride({
      spec: input,
      attribution: attribution(),
      retainedVersionIds: ["pv_a", "pv_b"],
    });
    expect(result.spec).toBe(input);
    expect(result.droppedVersionIds).toEqual([]);
  });

  it("rejects a version the environment does not pin — a request is not a grant", () => {
    expect(() =>
      applyPluginVersionOverride({
        spec: spec(),
        attribution: attribution(),
        retainedVersionIds: ["pv_a", "pv_elsewhere"],
      })
    ).toThrowError(/can only narrow/i);
  });

  it("fails closed when a dropped version cannot be attributed", () => {
    // Running anyway would keep the switched-off plugin's servers in the turn.
    expect(() =>
      applyPluginVersionOverride({
        spec: spec(),
        attribution: null,
        retainedVersionIds: ["pv_a"],
      })
    ).toThrowError(/could not be identified/i);

    expect(() =>
      applyPluginVersionOverride({
        spec: spec(),
        attribution: { ...attribution(), unattributedVersionIds: ["pv_b"] },
        retainedVersionIds: ["pv_a"],
      })
    ).toThrowError(/could not be identified/i);
  });

  it("never removes a server the backend attributed to the host", () => {
    // A torn attribution map can name a plugin for a server the environment
    // classified as the host's own. The backend's `source` wins.
    const input = spec();
    input.servers.connectable = [
      { serverId: "srv_host", name: "linear", source: "host_or_group" },
      { serverId: "srv_b", name: "b-tools", source: "plugin" },
    ];
    input.servers.effectiveServerIds = ["srv_host", "srv_b"];
    const attributed = attribution();
    attributed.serverOrigins.set("srv_host", version("pv_b", "beta"));

    const result = applyPluginVersionOverride({
      spec: input,
      attribution: attributed,
      retainedVersionIds: ["pv_a"],
    });
    expect(result.spec.servers.effectiveServerIds).toEqual(["srv_host"]);
  });

  it("keeps a skill the environment also delivers on its own channel", () => {
    const input = spec();
    input.skills = [skill("skl_b", ["plugin", "environment"])];
    const result = applyPluginVersionOverride({
      spec: input,
      attribution: attribution(),
      retainedVersionIds: ["pv_a"],
    });
    expect(result.spec.skills?.map((s) => s.skillId)).toEqual(["skl_b"]);
    expect(result.droppedSkillIds).toEqual([]);
  });
});
