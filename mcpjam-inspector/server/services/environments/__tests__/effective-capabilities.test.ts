import { describe, expect, it } from "vitest";
import {
  allEffectiveSkills,
  pluginOriginByServerId,
  resolveEffectiveCapabilities,
} from "../effective-capabilities";
import type { PluginRuntimeAttribution } from "../plugin-attribution";
import type { ResolvedEnvironmentRuntime } from "../runtime";

const PLUGIN_A = {
  pluginId: "p_a",
  pluginVersionId: "pv_a",
  name: "alpha",
  bundleHash: "aaaa1111",
};
const PLUGIN_B = {
  pluginId: "p_b",
  pluginVersionId: "pv_b",
  name: "beta",
  bundleHash: "bbbb2222",
};

function spec(
  overrides: Partial<ResolvedEnvironmentRuntime> = {}
): ResolvedEnvironmentRuntime {
  return {
    specVersion: 1,
    environmentRef: { environmentId: "env_1", name: "Staging", revision: 3 },
    host: { hostId: "host_1", runtimeConfig: { modelId: "m" } },
    servers: { effectiveServerIds: [] },
    ...overrides,
  };
}

function attribution(
  overrides: Partial<PluginRuntimeAttribution> = {}
): PluginRuntimeAttribution {
  return {
    serverOrigins: new Map(),
    skillOrigins: new Map(),
    unattributedVersionIds: [],
    ...overrides,
  };
}

describe("resolveEffectiveCapabilities — servers", () => {
  it("splits the connectable set into explicit and plugin-contributed ids", () => {
    const set = resolveEffectiveCapabilities(
      spec({
        servers: {
          selectedServerIds: ["srv_host"],
          pluginServerIds: ["srv_plugin"],
          baseEffectiveServerIds: ["srv_host", "srv_plugin"],
          effectiveServerIds: ["srv_host", "srv_plugin"],
          connectable: [
            { serverId: "srv_host", name: "Host", source: "host_or_group" },
            { serverId: "srv_plugin", name: "Plugin", source: "plugin" },
          ],
        },
        pluginVersions: [PLUGIN_A],
      }),
      attribution({
        serverOrigins: new Map([["srv_plugin", PLUGIN_A]]),
      })
    );

    expect(set.explicitServerIds).toEqual(["srv_host"]);
    expect(set.pluginServerIds).toEqual(["srv_plugin"]);
    // Connection order is preserved — the manager connects this list verbatim.
    expect(set.effectiveServerIds).toEqual(["srv_host", "srv_plugin"]);
    expect(pluginOriginByServerId(set)).toEqual({ srv_plugin: PLUGIN_A });
  });

  it("classifies by the backend's own `source` before falling back to the id hint", () => {
    // An override kept a plugin server; `pluginServerIds` is the BASE set, so
    // the hint alone would be wrong for anything the override introduced.
    const set = resolveEffectiveCapabilities(
      spec({
        servers: {
          pluginServerIds: ["srv_plugin", "srv_dropped"],
          baseEffectiveServerIds: ["srv_plugin", "srv_dropped"],
          effectiveServerIds: ["srv_plugin", "srv_extra"],
          connectable: [
            { serverId: "srv_plugin", name: "Plugin", source: "plugin" },
            { serverId: "srv_extra", name: "Extra", source: "override" },
          ],
        },
        pluginVersions: [PLUGIN_A],
      }),
      attribution()
    );

    expect(set.pluginServerIds).toEqual(["srv_plugin"]);
    expect(set.explicitServerIds).toEqual(["srv_extra"]);
  });

  it("never lets a stale attribution reclassify a server the backend called non-plugin", () => {
    // Attribution decides what we SAY about a server, never what it IS. A torn
    // or stale map that still lists an id the backend explicitly labelled
    // `host_or_group` must not move it into the plugin set.
    const set = resolveEffectiveCapabilities(
      spec({
        servers: {
          pluginServerIds: [],
          effectiveServerIds: ["srv_host"],
          connectable: [
            { serverId: "srv_host", name: "Host", source: "host_or_group" },
          ],
        },
      }),
      attribution({ serverOrigins: new Map([["srv_host", PLUGIN_A]]) })
    );

    expect(set.pluginServerIds).toEqual([]);
    expect(set.explicitServerIds).toEqual(["srv_host"]);
    expect(set.servers[0].plugin).toBeUndefined();
  });

  it("does the same for an override-sourced server", () => {
    const set = resolveEffectiveCapabilities(
      spec({
        servers: {
          effectiveServerIds: ["srv_extra"],
          connectable: [
            { serverId: "srv_extra", name: "Extra", source: "override" },
          ],
        },
      }),
      attribution({ serverOrigins: new Map([["srv_extra", PLUGIN_A]]) })
    );
    expect(set.pluginServerIds).toEqual([]);
    expect(set.servers[0].plugin).toBeUndefined();
  });

  it("uses attribution to classify only when the backend omitted `source`", () => {
    const set = resolveEffectiveCapabilities(
      spec({
        servers: {
          effectiveServerIds: ["srv_x"],
          connectable: [{ serverId: "srv_x", name: "X", source: undefined }],
        },
      }),
      attribution({ serverOrigins: new Map([["srv_x", PLUGIN_A]]) })
    );
    expect(set.pluginServerIds).toEqual(["srv_x"]);
    expect(set.servers[0].plugin).toEqual(PLUGIN_A);
  });

  it("falls back to raw ids when an older backend omits the connectable projection", () => {
    const set = resolveEffectiveCapabilities(
      spec({
        servers: {
          pluginServerIds: ["srv_plugin"],
          effectiveServerIds: ["srv_host", "srv_plugin"],
        },
      }),
      attribution()
    );

    expect(set.effectiveServerIds).toEqual(["srv_host", "srv_plugin"]);
    expect(set.pluginServerIds).toEqual(["srv_plugin"]);
    expect(set.servers.map((entry) => entry.source)).toEqual([null, null]);
  });
});

describe("resolveEffectiveCapabilities — skills", () => {
  const pluginSkill = (skillId: string) => ({
    skillId,
    name: "summarize",
    description: "Summarize things",
    content: `body ${skillId}`,
    aggregateHash: `agg_${skillId}`,
    channels: ["plugin" as const],
    files: [],
  });

  it("namespaces two plugins declaring the same skill name onto distinct refs", () => {
    const set = resolveEffectiveCapabilities(
      spec({
        skills: [pluginSkill("sk_a"), pluginSkill("sk_b")],
        pluginVersions: [PLUGIN_A, PLUGIN_B],
      }),
      attribution({
        skillOrigins: new Map([
          ["sk_a", { modelRef: "alpha/summarize", plugin: PLUGIN_A }],
          ["sk_b", { modelRef: "beta/summarize", plugin: PLUGIN_B }],
        ]),
      })
    );

    expect(set.pluginSkills.map((skill) => skill.ref)).toEqual([
      "alpha/summarize",
      "beta/summarize",
    ]);
    // Each ref keeps ITS OWN content and originating version.
    expect(set.pluginSkills[0].content).toBe("body sk_a");
    expect(set.pluginSkills[0].plugin).toEqual(PLUGIN_A);
    expect(set.pluginSkills[1].content).toBe("body sk_b");
    expect(set.pluginSkills[1].plugin).toEqual(PLUGIN_B);
    expect(set.problems).toEqual([]);
  });

  it("advertises ONLY the resolved set — an isolated plugin-only turn has no standalone skills", () => {
    const set = resolveEffectiveCapabilities(
      spec({
        skills: [pluginSkill("sk_a")],
        pluginVersions: [PLUGIN_A],
      }),
      attribution({
        skillOrigins: new Map([
          ["sk_a", { modelRef: "alpha/summarize", plugin: PLUGIN_A }],
        ]),
      })
    );

    expect(set.standaloneSkills).toEqual([]);
    expect(allEffectiveSkills(set).map((skill) => skill.ref)).toEqual([
      "alpha/summarize",
    ]);
  });

  it("keeps standalone skills on their bare name and records their channels", () => {
    const set = resolveEffectiveCapabilities(
      spec({
        skills: [
          {
            skillId: "sk_std",
            name: "release-notes",
            description: "Write release notes",
            content: "body",
            aggregateHash: "agg",
            channels: ["host", "environment"],
            files: [{ path: "scripts/run.py", size: 12, url: "https://x/1" }],
          },
        ],
      }),
      attribution()
    );

    expect(set.standaloneSkills).toEqual([
      {
        ref: "release-notes",
        skillId: "sk_std",
        name: "release-notes",
        description: "Write release notes",
        content: "body",
        aggregateHash: "agg",
        channels: ["host", "environment"],
        files: [{ path: "scripts/run.py", size: 12, url: "https://x/1" }],
      },
    ]);
    expect(set.pluginSkills).toEqual([]);
  });

  it("reports a plugin skill it could not namespace instead of hiding the ambiguity", () => {
    const set = resolveEffectiveCapabilities(
      spec({ skills: [pluginSkill("sk_a")], pluginVersions: [PLUGIN_A] }),
      attribution()
    );

    expect(set.pluginSkills[0].ref).toBe("summarize");
    expect(set.pluginSkills[0].plugin).toBeUndefined();
    expect(set.problems).toEqual([
      expect.objectContaining({
        code: "plugin_skill_ref_unavailable",
        skillId: "sk_a",
      }),
    ]);
  });

  it("drops the second of two colliding refs and says so", () => {
    const set = resolveEffectiveCapabilities(
      spec({ skills: [pluginSkill("sk_a"), pluginSkill("sk_b")] }),
      attribution()
    );

    expect(set.pluginSkills).toHaveLength(1);
    expect(set.problems.map((problem) => problem.code)).toEqual([
      "plugin_skill_ref_unavailable",
      "plugin_skill_ref_unavailable",
      "skill_ref_collision",
    ]);
  });
});

describe("resolveEffectiveCapabilities — degraded attribution", () => {
  it("still runs every server and skill when attribution is unavailable", () => {
    const set = resolveEffectiveCapabilities(
      spec({
        servers: {
          pluginServerIds: ["srv_plugin"],
          effectiveServerIds: ["srv_plugin"],
          connectable: [
            { serverId: "srv_plugin", name: "Plugin", source: "plugin" },
          ],
        },
        pluginVersions: [PLUGIN_A],
      }),
      null
    );

    expect(set.effectiveServerIds).toEqual(["srv_plugin"]);
    expect(set.pluginServerIds).toEqual(["srv_plugin"]);
    expect(set.servers[0].plugin).toBeUndefined();
    expect(set.problems).toEqual([
      expect.objectContaining({ code: "plugin_origin_unavailable" }),
    ]);
  });

  it("reports a PARTIAL attribution instead of passing a short map off as complete", () => {
    // pv_b resolved for the environment but not for the probe. Its components
    // still run; losing their provenance silently is the exact failure
    // `problems` exists to prevent.
    const set = resolveEffectiveCapabilities(
      spec({ pluginVersions: [PLUGIN_A, PLUGIN_B] }),
      attribution({
        serverOrigins: new Map([["srv_a", PLUGIN_A]]),
        unattributedVersionIds: ["pv_b"],
      })
    );

    expect(set.problems).toEqual([
      expect.objectContaining({ code: "plugin_origin_unavailable" }),
    ]);
    expect(set.problems[0].message).toContain("1 of this turn's 2");
    // The attribution we DID get is still used.
    expect(set.pluginVersions).toEqual([PLUGIN_A, PLUGIN_B]);
  });

  it("reports no problem when there was nothing to attribute", () => {
    const set = resolveEffectiveCapabilities(spec(), null);
    expect(set.problems).toEqual([]);
    expect(set.pluginVersions).toEqual([]);
  });

  it("carries pin order and bundle hashes from the spec, not from attribution", () => {
    const set = resolveEffectiveCapabilities(
      spec({ pluginVersions: [PLUGIN_B, PLUGIN_A] }),
      attribution()
    );
    expect(set.pluginVersions).toEqual([PLUGIN_B, PLUGIN_A]);
  });

  it("normalizes a missing bundleHash to null rather than synthesizing one", () => {
    const set = resolveEffectiveCapabilities(
      spec({
        pluginVersions: [{ pluginId: "p", pluginVersionId: "pv", name: "x" }],
      }),
      attribution()
    );
    expect(set.pluginVersions[0].bundleHash).toBeNull();
  });
});
